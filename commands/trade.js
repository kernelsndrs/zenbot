var tb = require('timebucket')
  , minimist = require('minimist')
  , n = require('numbro')
  , fs = require('fs')
  , path = require('path')
  , spawn = require('child_process').spawn
  , spawnSync = require('child_process').spawnSync
  , moment = require('moment')
  , crypto = require('crypto')
  , readline = require('readline')
  , colors = require('colors')
  , z = require('zero-fill')
  , cliff = require('cliff')
  , blessed = require('blessed')
  , contrib = require('blessed-contrib')

module.exports = function container (get, set, clear) {
  var c = get('conf')
  return function (program) {
    program
      .command('trade [selector]')
      .allowUnknownOption()
      .description('run trading bot against live market data')
      .option('--conf <path>', 'path to optional conf overrides file')
      .option('--strategy <name>', 'strategy to use', String, c.strategy)
      .option('--order_type <type>', 'order type to use (maker/taker)', /^(maker|taker)$/i, c.order_type)
      .option('--paper', 'use paper trading mode (no real trades will take place)', Boolean, false)
      .option('--manual', 'watch price and account balance, but do not perform trades automatically', Boolean, false)
      .option('--non_interactive', 'disable keyboard inputs to the bot', Boolean, false)
      .option('--currency_capital <amount>', 'for paper trading, amount of start capital in currency', Number, c.currency_capital)
      .option('--asset_capital <amount>', 'for paper trading, amount of start capital in asset', Number, c.asset_capital)
      .option('--avg_slippage_pct <pct>', 'avg. amount of slippage to apply to paper trades', Number, c.avg_slippage_pct)
      .option('--buy_pct <pct>', 'buy with this % of currency balance', Number, c.buy_pct)
      .option('--buy_max_amt <amt>', 'buy with up to this amount of currency balance', Number, c.buy_max_amt)
      .option('--sell_pct <pct>', 'sell with this % of asset balance', Number, c.sell_pct)
      .option('--markdown_buy_pct <pct>', '% to mark down buy price', Number, c.markdown_buy_pct)
      .option('--markup_sell_pct <pct>', '% to mark up sell price', Number, c.markup_sell_pct)
      .option('--order_adjust_time <ms>', 'adjust bid/ask on this interval to keep orders competitive', Number, c.order_adjust_time)
      .option('--order_poll_time <ms>', 'poll order status on this interval', Number, c.order_poll_time)
      .option('--sell_stop_pct <pct>', 'sell if price drops below this % of bought price', Number, c.sell_stop_pct)
      .option('--buy_stop_pct <pct>', 'buy if price surges above this % of sold price', Number, c.buy_stop_pct)
      .option('--profit_stop_enable_pct <pct>', 'enable trailing sell stop when reaching this % profit', Number, c.profit_stop_enable_pct)
      .option('--profit_stop_pct <pct>', 'maintain a trailing stop this % below the high-water mark of profit', Number, c.profit_stop_pct)
      .option('--max_sell_loss_pct <pct>', 'avoid selling at a loss pct under this float', c.max_sell_loss_pct)
      .option('--max_slippage_pct <pct>', 'avoid selling at a slippage pct above this float', c.max_slippage_pct)
      .option('--rsi_periods <periods>', 'number of periods to calculate RSI at', Number, c.rsi_periods)
      .option('--poll_trades <ms>', 'poll new trades at this interval in ms', Number, c.poll_trades)
      .option('--currency_increment <amount>', 'Currency increment, if different than the asset increment', String, null)
      .option('--keep_lookback_periods <amount>', 'Keep this many lookback periods max. ', Number, c.keep_lookback_periods)
      .option('--disable_stats', 'disable printing order stats')
      .option('--reset_profit', 'start new profit calculation from 0')
      .option('--debug', 'output detailed debug info')
      .action(function (selector, cmd) {

        let common_opts = minimist(process.argv)
        let s = {options: JSON.parse(JSON.stringify(common_opts))}
        let so = s.options
        delete so._
        Object.keys(c).forEach(function (k) {
          if (typeof cmd[k] !== 'undefined') {
            so[k] = cmd[k]
          }
        })
        //
        // var _log = console.log;
        // console.log = function(message){
        //   s.info_log.log(message)
        // };
        // var _error = console.error;
        // console.error = function(message) {
        //   if(typeof message === 'object') message = JSON.stringify((message))
        //   s.error_log.log(message)
        // }
        so.currency_increment = cmd.currency_increment
        so.keep_lookback_periods = cmd.keep_lookback_periods
        so.debug = cmd.debug
        so.stats = !cmd.disable_stats
        s.shouldSaveStats = false
        so.mode = so.paper ? 'paper' : 'live'
        so.selector = get('lib.objectify-selector')(selector || c.selector)
        let order_types = ['maker', 'taker']
        if(!so.order_type in order_types || !so.order_type) {
          so.order_type = 'maker'
        }
        let exchange = get('exchanges.' + so.selector.exchange_id)
        if(!exchange) {
          console.error('cannot trade ' + so.selector.normalized + ': exchange not implemented')
          process.exit(1)
        }
        let engine = get('lib.engine')(s)
        engine.createTextUI()


        function displayLinesArrPopup(linesArr) {

          let popup_box = blessed.box({
            top: 'center',
            left: 'center',
            width: '50%',
            height: '50%',
            tags: true,
            border: {
              type: 'line'
            },
            style: {
              fg: 'white',
              bg: 'magenta',
              border: {
                fg: '#f0f0f0'
              },
              hover: {
                bg: 'green'
              }
            },
            scrollable: true,
            alwaysScroll: true,
            scrollbar: {
              ch: ' ',
              inverse: true
            }
          });
          s.screen.append(popup_box)
          popup_box.pushLine(linesArr)
          popup_box.on('click', function(data) {
            popup_box.destroy()
            s.screen.render()
          })
          popup_box.key('q', function(ch, key) {
            popup_box.destroy()
            s.screen.render()
          })
          popup_box.focus()
          s.screen.render()
        }
        function listKeys() {
          const keyMap = new Map()
          keyMap.set('b', 'limit'.grey + ' BUY'.green)
          keyMap.set('B', 'market'.grey + ' BUY'.green)
          keyMap.set('s', 'limit'.grey + ' SELL'.red)
          keyMap.set('S', 'market'.grey + ' SELL'.red)
          keyMap.set('c', 'cancel order'.grey)
          keyMap.set('m', 'toggle MANUAL trade in LIVE mode ON / OFF'.grey)
          keyMap.set('T', 'switch to \'Taker\' order type'.grey)
          keyMap.set('M', 'switch to \'Maker\' order type'.grey)
          keyMap.set('o', 'show current trade options'.grey)
          keyMap.set('O', 'show current trade options in a dirty view (full list)'.grey)
          keyMap.set('L', 'toggle DEBUG'.grey)
          keyMap.set('P', 'print statistical output'.grey)
          keyMap.set('X', 'exit program with statistical output'.grey)
          keyMap.set('d', 'dump statistical output to HTML file'.grey)
          keyMap.set('D', 'toggle automatic HTML dump to file'.grey)
          keyMap.set('q', 'Close current prompt'.grey)
          let lines = []
          lines.push('\nAvailable command keys:\n\n')
          keyMap.forEach((value, key) => {
            lines.push(' ' + key + ' - ' + value+'\n')
          })
          displayLinesArrPopup(lines)
        }
        function setupKeyboardCommands(){

          // s.screen.key([''], function(ch, key) {
          // })
          // s.screen.key(['C-e'], function(ch, key) {
          //   console.error({error: " object error"})
          // })
          s.screen.key(['C-s'], function(ch, key) {
            s.screen.line_chart.toggle()
          })
          s.screen.key(['l'], function(ch, key) {
            listKeys()
          })
          s.screen.key(['b'], function(ch, key) {
            s.info_log.log('manual'.grey + ' limit ' + 'BUY'.green + ' command executed'.grey)
            engine.executeSignal('buy')
          })
          s.screen.key(['S-b'], function(ch, key) {
            engine.executeSignal('buy', null, null, false, true)
            s.info_log.log('manual'.grey + ' market ' + 'BUY'.green + ' command executed'.grey)
          })
          s.screen.key(['s'], function(ch, key) {
            engine.executeSignal('sell')
            s.info_log.log('manual'.grey + ' limit ' + 'SELL'.red + ' command executed'.grey)
          })
          s.screen.key(['S-s'], function(ch, key) {
            engine.executeSignal('sell', null, null, false, true)
            s.info_log.log('manual'.grey + ' market ' + 'SELL'.red + ' command executed'.grey)
          })
          s.screen.key(['c', 'S-c'], function(ch, key) {
            delete s.buy_order
            delete s.sell_order
            s.info_log.log('manual'.grey + ' order cancel' + ' command executed'.grey)
          })
          if(so.mode === 'live'){
            s.screen.key(['m'], function(ch, key) {
              so.manual = !so.manual
              s.info_log.log('MANUAL trade in LIVE mode: ' + (so.manual ? 'ON'.green.inverse : 'OFF'.red.inverse))
            })
          }
          s.screen.key(['S-t'], function(ch, key) {
            so.order_type = 'taker'
            s.info_log.log('Taker fees activated'.bgRed)
          })
          s.screen.key(['S-m'], function(ch, key) {
            so.order_type = 'maker'
            s.info_log.log('Maker fees activated'.black.bgGreen)
          })
          s.screen.key(['o'], function(ch, key) {
            listOptions()
          })
          s.screen.key(['S-o'], function(ch, key) {
            s.info_log.log(cliff.inspect(so))
          })
          s.screen.key(['S-p'], function(ch, key) {
            s.info_log.log('Writing statistics...'.grey)
            printTrade(false)
          })
          s.screen.key(['S-x'], function(ch, key) {
            s.info_log.log('Exiting... ' + 'Writing statistics...'.grey)
            printTrade(true)
          })
          s.screen.key(['d'], function(ch, key) {
            s.info_log.log('Dumping statistics...'.grey)
            printTrade(false, true)
          })
          s.screen.key(['S-d'], function(ch, key) {
            s.info_log.log('Dumping statistics...'.grey)
            toggleStats()
          })
          s.screen.key(['S-l'], function(ch, key) {
            so.debug = !so.debug
            s.info_log.log('DEBUG mode: ' + (so.debug ? 'ON'.green.inverse : 'OFF'.red.inverse))
          })
          s.screen.key(['C-c'], function(ch, key) {
            // @todo: cancel open orders before exit
            s.info_log.log("Exiting")
            process.exit()
          })
        }
        function listOptions () {
          text = ''
          text += (s.exchange.name.toUpperCase() + ' exchange active trading options:'.grey)
          text += ('\n')
          text += (z(10, 'STRATEGY'.grey, ' ') + '\t' + so.strategy )
          text += ('\n')
          text += (z(10, 'DESC'.grey, ' ') + '\t' + (get('strategies.' + so.strategy).description).grey)
          text += ('\n')
          text += [
            z(10, 'MODE'.grey , ' ') + '\t' +  so.mode.toUpperCase() + (so.mode === 'live' && (so.manual === false || typeof so.manual === 'undefined')) ? '       ' + 'AUTO'.black.bgRed + '    ' : '       ' + 'MANUAL'.black.bgGreen + '  ',
            z(10, 'PERIOD'.grey, ' ') + '\t' + so.period_length,
            z(10, 'ORDER TYPE'.grey, ' ') + '\t' + (so.order_type === 'maker' ? so.order_type.toUpperCase().green : so.order_type.toUpperCase().red),
            z(10, 'SLIPPAGE'.grey, ' ') + '\t' + (so.mode === 'paper' ? 'avg. '.grey + so.avg_slippage_pct + '%' : 'max '.grey + so.max_slippage_pct + '%'),
            z(10, 'EXCHANGE FEES'.grey, ' ') + '\t' + (so.order_type === 'maker' ? so.order_type + ' ' + s.exchange.makerFee : so.order_type + ' ' + s.exchange.takerFee)
          ].join('\n')
          text += ('\n')
          text += [
            z(20, 'BUY %'.grey, ' ') + '\t' + so.buy_pct + '%',
            z(20, 'SELL %'.grey, ' ') + '\t' + so.sell_pct + '%',
            z(20, 'TRAILING STOP %'.grey, ' ') + '\t' + so.profit_stop_enable_pct + '%',
            z(20, 'TRAILING DISTANCE %'.grey, ' ') + '\t' + so.profit_stop_pct + '%'
          ].join('\n')
          displayLinesArrPopup(text)

        }              

        //Stats Functions
        function printTrade (quit, dump) {
          console.log()
          var output_lines = []
          var tmp_balance = n(s.balance.currency).add(n(s.period.close).multiply(s.balance.asset)).format('0.00000000')
          if (quit) {
            if (s.my_trades.length) {
              s.my_trades.push({
                price: s.period.close,
                size: s.balance.asset,
                type: 'sell',
                time: s.period.time
              })
            }
            s.balance.currency = tmp_balance
            s.balance.asset = 0
            s.lookback.unshift(s.period)
          }
          var profit = s.start_capital ? n(tmp_balance).subtract(s.start_capital).divide(s.start_capital) : n(0)
          output_lines.push('last balance: ' + n(tmp_balance).format('0.00000000').yellow + ' (' + profit.format('0.00%') + ')')
          var buy_hold = s.start_price ? n(s.period.close).multiply(n(s.start_capital).divide(s.start_price)) : n(tmp_balance)
          var buy_hold_profit = s.start_capital ? n(buy_hold).subtract(s.start_capital).divide(s.start_capital) : n(0)
          output_lines.push('buy hold: ' + buy_hold.format('0.00000000').yellow + ' (' + n(buy_hold_profit).format('0.00%') + ')')
          output_lines.push('vs. buy hold: ' + n(tmp_balance).subtract(buy_hold).divide(buy_hold).format('0.00%').yellow)
          output_lines.push(s.my_trades.length + ' trades over ' + s.day_count + ' days (avg ' + n(s.my_trades.length / s.day_count).format('0.00') + ' trades/day)')
          // Build stats for UI
          s.stats = {
            profit: profit.format('0.00%'),
            tmp_balance: n(tmp_balance).format('0.00000000'),
            buy_hold: buy_hold.format('0.00000000'),
            buy_hold_profit: n(buy_hold_profit).format('0.00%'),
            day_count: s.day_count,
            trade_per_day: n(s.my_trades.length / s.day_count).format('0.00')
          }

          var last_buy
          var losses = 0, sells = 0
          s.my_trades.forEach(function (trade) {
            if (trade.type === 'buy') {
              last_buy = trade.price
            }
            else {
              if (last_buy && trade.price < last_buy) {
                losses++
              }
              sells++
            }
          })
          if (s.my_trades.length && sells > 0) {
            output_lines.push('win/loss: ' + (sells - losses) + '/' + losses)
            output_lines.push('error rate: ' + (sells ? n(losses).divide(sells).format('0.00%') : '0.00%').yellow)

            //for API
            s.stats.win = (sells - losses)
            s.stats.losses = losses
            s.stats.error_rate = (sells ? n(losses).divide(sells).format('0.00%') : '0.00%')
          }
          output_lines.forEach(function (line) {
            console.log(line)
          })
          if (quit || dump) {
            var html_output = output_lines.map(function (line) {
              return colors.stripColors(line)
            }).join('\n')
            var data = s.lookback.slice(0, s.lookback.length - so.min_periods).map(function (period) {
              var data = {};
              var keys = Object.keys(period);
              for(i = 0;i < keys.length;i++){
                data[keys[i]] = period[keys[i]];
              }
              return data;
            })
            var code = 'var data = ' + JSON.stringify(data) + ';\n'
            code += 'var trades = ' + JSON.stringify(s.my_trades) + ';\n'
            var tpl = fs.readFileSync(path.resolve(__dirname, '..', 'templates', 'sim_result.html.tpl'), {encoding: 'utf8'})
            var out = tpl
              .replace('{{code}}', code)
              .replace('{{trend_ema_period}}', so.trend_ema || 36)
              .replace('{{output}}', html_output)
              .replace(/\{\{symbol\}\}/g,  so.selector.normalized + ' - zenbot ' + require('../package.json').version)
            if (so.filename !== 'none') {
              var out_target
              var out_target_prefix = so.paper ? 'simulations/paper_result_' : 'stats/trade_result_'
              if(dump){
                var dt = new Date().toISOString();
                
                //ymd
                var today = dt.slice(2, 4) + dt.slice(5, 7) + dt.slice(8, 10);
                out_target = so.filename || out_target_prefix + so.selector.normalized +'_' + today + '_UTC.html'
              fs.writeFileSync(out_target, out)
              }else
                out_target = so.filename || out_target_prefix + so.selector.normalized +'_' + new Date().toISOString().replace(/T/, '_').replace(/\..+/, '').replace(/-/g, '').replace(/:/g, '').replace(/20/, '') + '_UTC.html'
              
              fs.writeFileSync(out_target, out)
              console.log('\nwrote'.grey, out_target)
            }
            if(quit) process.exit(0)
          }
        }
        function toggleStats(){
          s.shouldSaveStats = !s.shouldSaveStats;
          if(s.shouldSaveStats)
            s.info_log.log("Auto stats dump enabled")
          else
            s.info_log.log("Auto stats dump disabled")
        }
        function saveStats () {
          if(!s.shouldSaveStats) return;
          printTrade(false, true)
        }
        function saveStatsLoop(){
          saveStats()
          setTimeout(function () {
            saveStatsLoop()
          }, 10000)
        }
        saveStatsLoop()
        


        let db_cursor, trade_cursor
        let query_start = tb().resize(so.period_length).subtract(so.min_periods * 2).toMilliseconds()
        let days = Math.ceil((new Date().getTime() - query_start) / 86400000)
        let session = null
        let sessions = get('db.sessions')
        let balances = get('db.balances')
        let trades = get('db.trades')
        let my_trades = get('db.my_trades')
        let periods = get('db.periods')
        let resume_markers = get('db.resume_markers')
        get('db.mongo').collection('trades').ensureIndex({selector: 1, time: 1})
        get('db.mongo').collection('resume_markers').ensureIndex({selector: 1, to: -1})
        let marker = {
          id: crypto.randomBytes(4).toString('hex'),
          selector: so.selector.normalized,
          from: null,
          to: null,
          oldest_time: null
        }
        let lookback_size = 0
        let my_trades_size = 0

        s.info_log.log('Starting Backfill:')
        let zenbot_cmd = process.platform === 'win32' ? 'zenbot.bat' : 'zenbot.sh'; // Use 'win32' for 64 bit windows too
        let backfiller = spawn(path.resolve(__dirname, '..', zenbot_cmd), ['backfill', so.selector.normalized, '--days', days])
        backfiller.stdout.on('data', function(data){
          if(data.toString() === '.') data = "gathering backfill.."
          s.info_log.log(data.toString())
        })
        backfiller.stderr.on('data', function(data){
          s.error_log.log("err: " + data.toString())
        })
        backfiller.on('exit',
          function (code) {
          if (code) {
            process.exit(code)
          }
          console.log('Backfill complete ')
          function getNext () {
            var opts = {
              query: {
                selector: so.selector.normalized
              },
              sort: {time: 1},
              limit: 1000
            }
            if (db_cursor) {
              opts.query.time = {$gt: db_cursor}
            }
            else {
              trade_cursor = s.exchange.getCursor(query_start)
              opts.query.time = {$gte: query_start}
            }
            get('db.trades').select(opts, function (err, trades) {
              if (err) throw err
              if (!trades.length) {
                var head = '------------------------------------------ INITIALIZE  OUTPUT ------------------------------------------';
                console.log(head)
                get('lib.output').initializeOutput(s)
                setupKeyboardCommands()
                var minuses = Math.floor((head.length - so.mode.length - 19) / 2)
                console.log('-'.repeat(minuses) + ' STARTING ' + so.mode.toUpperCase() + ' TRADING ' + '-'.repeat(minuses + (minuses % 2 == 0 ? 0 : 1)))
                if (so.mode === 'paper') {
                  console.log('!!! Paper mode enabled. No real trades are performed until you remove --paper from the startup command.')
                }
                console.log('Press ' + ' l '.inverse + ' to list available commands.')
                engine.syncBalance(function (err) {
                  if (err) {
                    if (err.desc) console.error(err.desc)
                    if (err.body) console.error(err.body)
                    throw err
                  }
                  session = {
                    id: crypto.randomBytes(4).toString('hex'),
                    selector: so.selector.normalized,
                    started: new Date().getTime(),
                    mode: so.mode,
                    options: so
                  }
                  sessions.select({query: {selector: so.selector.normalized}, limit: 1, sort: {started: -1}}, function (err, prev_sessions) {
                    if (err) throw err
                    var prev_session = prev_sessions[0]
                    if (prev_session && !cmd.reset_profit) {
                      if (prev_session.orig_capital && prev_session.orig_price && ((so.mode === 'paper' && !common_opts.currency_capital && !common_opts.asset_capital) || (so.mode === 'live' && prev_session.balance.asset == s.balance.asset && prev_session.balance.currency == s.balance.currency))) {
                        s.orig_capital = session.orig_capital = prev_session.orig_capital
                        s.orig_price = session.orig_price = prev_session.orig_price
                        if (so.mode === 'paper') {
                          s.balance = prev_session.balance
                        }
                      }
                    }
                    if(lookback_size = s.lookback.length > so.keep_lookback_periods){
                      s.lookback.splice(-1,1)
                    }

                    forwardScan()
                    setInterval(forwardScan, so.poll_trades)
                  })
                })
                return
              }
              engine.update(trades, true, function (err) {
                if (err) throw err
                db_cursor = trades[trades.length - 1].time
                trade_cursor = exchange.getCursor(trades[trades.length - 1])
                setImmediate(getNext)
              })
            })
          }
          engine.writeHeader()
          getNext()
        })

        var prev_timeout = null
        function forwardScan () {
          function saveSession () {
            engine.syncBalance(function (err) {
              if (!err && s.balance.asset === undefined) {
                // TODO not the nicest place to verify the state, but did not found a better one
                throw new Error('Error during syncing balance. Please check your API-Key')
              }
              if (err) {
                console.error('\n' + moment().format('YYYY-MM-DD HH:mm:ss') + ' - error syncing balance')
                if (err.desc) console.error(err.desc)
                if (err.body) console.error(err.body)
                console.error(err)
              }
              session.updated = new Date().getTime()
              session.balance = s.balance
              session.start_capital = s.start_capital
              session.start_price = s.start_price
              session.num_trades = s.my_trades.length
              if (!session.orig_capital) session.orig_capital = s.start_capital
              if (!session.orig_price) session.orig_price = s.start_price
              if (s.period) {
                session.price = s.period.close
                var d = tb().resize(c.balance_snapshot_period)
                var b = {
                  id: so.selector.normalized + '-' + d.toString(),
                  selector: so.selector.normalized,
                  time: d.toMilliseconds(),
                  currency: s.balance.currency,
                  asset: s.balance.asset,
                  price: s.period.close,
                  start_capital: session.orig_capital,
                  start_price: session.orig_price,
                }
                b.consolidated = n(s.balance.asset).multiply(s.period.close).add(s.balance.currency).value()
                b.profit = (b.consolidated - session.orig_capital) / session.orig_capital
                b.buy_hold = s.period.close * (session.orig_capital / session.orig_price)
                b.buy_hold_profit = (b.buy_hold - session.orig_capital) / session.orig_capital
                b.vs_buy_hold = (b.consolidated - b.buy_hold) / b.buy_hold
                if (so.mode === 'live') {
                  balances.save(b, function (err) {
                    if (err) {
                      console.error('\n' + moment().format('YYYY-MM-DD HH:mm:ss') + ' - error saving balance')
                      console.error(err)
                    }
                  })
                }
                session.balance = b
              }
              else {
                session.balance = {
                  currency: s.balance.currency,
                  asset: s.balance.asset
                }
              }
              sessions.save(session, function (err) {
                if (err) {
                  console.error('\n' + moment().format('YYYY-MM-DD HH:mm:ss') + ' - error saving session')
                  console.error(err)
                }
                if (s.period) {
                  engine.writeReport(true)
                } else {
                  readline.clearLine(process.stdout)
                  readline.cursorTo(process.stdout, 0)
                  console.log('Waiting on first live trade to display reports, could be a few minutes ...')
                }
              })
            })
          }
          var opts = {product_id: so.selector.product_id, from: trade_cursor}
          exchange.getTrades(opts, function (err, trades) {
            if (err) {
              if (err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND' || err.code === 'ECONNRESET') {
                if (prev_timeout) {
                  console.error('\n' + moment().format('YYYY-MM-DD HH:mm:ss') + ' - getTrades request timed out. retrying...')
                }
                prev_timeout = true
              }
              else if (err.code === 'HTTP_STATUS') {
                if (prev_timeout) {
                  console.error('\n' + moment().format('YYYY-MM-DD HH:mm:ss') + ' - getTrades request failed: ' + err.message + '. retrying...')
                }
                prev_timeout = true
              }
              else {
                console.error('\n' + moment().format('YYYY-MM-DD HH:mm:ss') + ' - getTrades request failed. retrying...')
                console.error(err)
              }
              return
            }
            prev_timeout = null
            if (trades.length) {
              trades.sort(function (a, b) {
                if (a.time > b.time) return -1
                if (a.time < b.time) return 1
                return 0
              })
              trades.forEach(function (trade) {
                var this_cursor = exchange.getCursor(trade)
                trade_cursor = Math.max(this_cursor, trade_cursor)
                saveTrade(trade)
              })
              engine.update(trades, function (err) {
                if (err) {
                  console.error('\n' + moment().format('YYYY-MM-DD HH:mm:ss') + ' - error saving session')
                  console.error(err)
                }
                resume_markers.save(marker, function (err) {
                  if (err) {
                    console.error('\n' + moment().format('YYYY-MM-DD HH:mm:ss') + ' - error saving marker')
                    console.error(err)
                  }
                })
                if (s.my_trades.length > my_trades_size) {
                  s.my_trades.slice(my_trades_size).forEach(function (my_trade) {
                    my_trade.id = crypto.randomBytes(4).toString('hex')
                    my_trade.selector = so.selector.normalized
                    my_trade.session_id = session.id
                    my_trade.mode = so.mode
                    my_trades.save(my_trade, function (err) {
                      if (err) {
                        console.error('\n' + moment().format('YYYY-MM-DD HH:mm:ss') + ' - error saving my_trade')
                        console.error(err)
                      }
                    })
                  })
                  my_trades_size = s.my_trades.length
                }
                function savePeriod (period) {
                  if (!period.id) {
                    period.id = crypto.randomBytes(4).toString('hex')
                    period.selector = so.selector.normalized
                    period.session_id = session.id
                  }
                  periods.save(period, function (err) {
                    if (err) {
                      console.error('\n' + moment().format('YYYY-MM-DD HH:mm:ss') + ' - error saving my_trade')
                      console.error(err)
                    }
                  })
                }
                if (s.lookback.length > lookback_size) {
                  savePeriod(s.lookback[0])
                  lookback_size = s.lookback.length
                }
                if (s.period) {
                  savePeriod(s.period)
                }
                saveSession()
              })
            }
            else {
              saveSession()
            }
          })
          function saveTrade (trade) {
            trade.id = so.selector.normalized + '-' + String(trade.trade_id)
            trade.selector = so.selector.normalized
            if (!marker.from) {
              marker.from = trade_cursor
              marker.oldest_time = trade.time
              marker.newest_time = trade.time
            }
            marker.to = marker.to ? Math.max(marker.to, trade_cursor) : trade_cursor
            marker.newest_time = Math.max(marker.newest_time, trade.time)
            trades.save(trade, function (err) {
              // ignore duplicate key errors
              if (err && err.code !== 11000) {
                console.error('\n' + moment().format('YYYY-MM-DD HH:mm:ss') + ' - error saving trade')
                console.error(err)
              }
            })
          }
        }
      })
  }
}
