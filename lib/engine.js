var tb = require('timebucket')
  , moment = require('moment')
  , z = require('zero-fill')
  , n = require('numbro')
  , colors = require('colors')
  , series = require('run-series')
  , abbreviate = require('number-abbreviate')
  //Needed for Text UI
  , blessed = require('blessed')
  , contrib = require('blessed-contrib')
  //Needed for dumping statistics to disk
  , fs = require('fs')
  , path = require('path')


var nice_errors = new RegExp(/(slippage protection|loss protection)/)

module.exports = function container (get, set, clear) {
  var c = get('conf')
  var notify = get('lib.notify')

  return function (s) {
    let so = s.options
    s.exchange = get('exchanges.' + so.selector.exchange_id)
    s.product_id = so.selector.product_id
    s.asset = so.selector.asset
    s.currency = so.selector.currency
    s.asset_capital = 0


    let products = s.exchange.getProducts()
    products.forEach(function (product) {
      if (product.asset === s.asset && product.currency === s.currency) {
        s.product = product
      }
    })
    if (!s.product) {
      console.error('error: could not find product "' + s.product_id + '"')
      process.exit(1)
    }
    if ((so.mode === 'live' || so.mode === 'paper') && s.exchange.dynamicFees) {
      s.exchange.setFees({asset: s.asset, currency: s.currency})
    }
    if (so.mode === 'sim' || so.mode === 'paper') {
      s.balance = {asset: so.asset_capital, currency: so.currency_capital}
    }
    else {
      s.balance = {asset: 0, currency: 0}
    }

    s.ctx = {
      option: function (name, desc, type, def) {
        if (typeof so[name] === 'undefined') {
          so[name] = def
        }
      }
    }

    s.asset_col_width = 0
    s.currency_col_width = 0
    s.lookback = []
    s.day_count = 1
    s.my_trades = []
    s.vol_since_last_blink = 0
    s.max_fc_width = 0

    if (so.strategy) {
      s.strategy = get('strategies.' + so.strategy)
      if (s.strategy.getOptions) {
        s.strategy.getOptions.call(s.ctx, s)
      }
    }

    function memDump () {
      if (!so.debug) return
      var s_copy = JSON.parse(JSON.stringify(s))
      delete s_copy.options.mongo
      delete s_copy.lookback
      get('exchanges.list').forEach(function (x) {
        delete s_copy.options[x.name]
      })
      console.error(s_copy)
    }

    function createTextUI() {

      // Create a screen object.
      s.screen = blessed.screen({
        smartCSR: true,
        // log: process.env.HOME + '/blessed-terminal.log',
        fullUnicode: true,
        dockBorders: true,
        ignoreDockContrast: true
      });

      s.screen.title = 'Zenbot';
      s.grid = new contrib.grid({rows: 12, cols: 12, screen: s.screen})
      s.error_log = s.grid.set(0, 0, 1, 12, contrib.log, {
        label: 'Errors',
      })
      s.info_log = s.grid.set(1, 0, 5, 12, contrib.log, {
        label: 'Info',
      })
      s.recent_periods = s.grid.set(6, 0, 6, 12, contrib.log, {
        label: 'Recent Periods',
        scrollable: true,
      })
      s.line_chart = blessed.box ({
        screen: s.screen,
        hidden: true,
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
        }
      })
      s.screen.render()

    }

    function displayPopup(linesArr) {
      if(typeof s.popup_box !== 'undefined') {
        s.popup_box.destroy()
      }

      s.popup_box = blessed.box({
        top: 'center',
        left: 'center',
        width: '50%',
        height: '50%',
        tags: true,
        border: {
          type: 'line'
        },
        style: {
          fg: 'black',
          bg: 'white',
          border: {
            fg: '#f0f0f0'
          },
          hover: {
            fg: 'grey'
          }
        },
        scrollable: true,
        alwaysScroll: true,
        scrollbar: {
          ch: ' ',
          inverse: true
        }
      });

      s.screen.append(s.popup_box)
      s.popup_box.pushLine(linesArr)
      s.popup_box.on('click', function(data) {
        s.popup_box.destroy()
        s.screen.render()
      })
      s.popup_box.key('q', function(ch, key) {
        s.popup_box.destroy()
        s.screen.render()
      })
      s.popup_box.focus()
      s.screen.render()
    }

    function printTrade(quit, dump) {
      let output_lines = []
      let tmp_balance = n(s.balance.currency).add(n(s.period.close).multiply(s.balance.asset)).format('0.00000000')

      if (quit) {
        //looks like if quiting then it pushes a sale, plus sets the balance to tmp_balance and adds current period
        //Not sure if any of this should be kept
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
      let profit = s.start_capital ? n(tmp_balance).subtract(s.start_capital).divide(s.start_capital) : n(0)
      output_lines.push('last balance: ' + n(tmp_balance).format('0.00000000').yellow + ' (' + profit.format('0.00%') + ')'+'\n')
      let buy_hold = s.start_price ? n(s.period.close).multiply(n(s.start_capital).divide(s.start_price)) : n(tmp_balance)
      let buy_hold_profit = s.start_capital ? n(buy_hold).subtract(s.start_capital).divide(s.start_capital) : n(0)
      output_lines.push('buy hold: ' + buy_hold.format('0.00000000').yellow + ' (' + n(buy_hold_profit).format('0.00%') + ')'+'\n')
      output_lines.push('vs. buy hold: ' + n(tmp_balance).subtract(buy_hold).divide(buy_hold).format('0.00%').yellow+'\n')
      output_lines.push(s.my_trades.length + ' trades over ' + s.day_count + ' days (avg ' + n(s.my_trades.length / s.day_count).format('0.00') + ' trades/day)'+'\n')
      if (c.output.api.on) {
        // Build stats for UI
        s.stats = {
          profit: profit.format('0.00%'),
          tmp_balance: n(tmp_balance).format('0.00000000'),
          buy_hold: buy_hold.format('0.00000000'),
          buy_hold_profit: n(buy_hold_profit).format('0.00%'),
          day_count: s.day_count,
          trade_per_day: n(s.my_trades.length / s.day_count).format('0.00')
        }
      }

      let last_buy
      let losses = 0, sells = 0
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
        output_lines.push('win/loss: ' + (sells - losses) + '/' + losses+'\n')
        output_lines.push('error rate: ' + (sells ? n(losses).divide(sells).format('0.00%') : '0.00%').yellow+'\n')
        if (c.output.api.on) {
          //for API
          s.stats.win = (sells - losses)
          s.stats.losses = losses
          s.stats.error_rate = (sells ? n(losses).divide(sells).format('0.00%') : '0.00%')
        }
      }
      if (quit || dump) {
        let out_target
        let html_output = output_lines.map(function (line) {
          return colors.stripColors(line)
        }).join('\n')
        let data = s.lookback.slice(0, s.lookback.length - so.min_periods).map(function (period) {
          let data = {}
          let keys = Object.keys(period)
          for(i = 0;i < keys.length;i++){
            data[keys[i]] = period[keys[i]]
          }
          return data
        })
        let code = 'var data = ' + JSON.stringify(data) + ';\n'
        code += 'var trades = ' + JSON.stringify(s.my_trades) + ';\n'
        let tpl = fs.readFileSync(path.resolve(__dirname, '..', 'templates', 'sim_result.html.tpl'), {encoding: 'utf8'})
        let out = tpl
          .replace('{{code}}', code)
          .replace('{{trend_ema_period}}', so.trend_ema || 36)
          .replace('{{output}}', html_output)
          .replace(/\{\{symbol\}\}/g,  so.selector.normalized + ' - zenbot ' + require('../package.json').version)
        if (so.filename !== 'none') {
          let out_target_prefix = so.paper ? 'simulations/paper_result_' : 'stats/trade_result_'
          if(dump){
            let dt = new Date().toISOString();

            //ymd
            let today = dt.slice(2, 4) + dt.slice(5, 7) + dt.slice(8, 10);
            out_target = so.filename || out_target_prefix + so.selector.normalized +'_' + today + '_UTC.html'
            fs.writeFileSync(out_target, out)
          }else {
            out_target = so.filename || out_target_prefix + so.selector.normalized + '_' + new Date().toISOString().replace(/T/, '_').replace(/\..+/, '').replace(/-/g, '').replace(/:/g, '').replace(/20/, '') + '_UTC.html'
            fs.writeFileSync(out_target, out)
          }
          s.info_log.log('wrote ' + out_target)
        }
      }
      displayPopup(output_lines)
      if(quit) process.exit(0)

    }

    function msg (str) {
      if (so.debug) {
        console.error('\n' + moment().format('YYYY-MM-DD HH:mm:ss') + ' - ' + str)
      }
    }

    function pushMessage(title, message) {
      if (so.mode === 'live' || so.mode === 'paper') {
        notify.pushMessage(title, message)
      }
    }

    function fa (amt) {
      return n(amt).format('0.00000000') + ' ' + s.asset
    }

    function isFiat () {
      return !s.currency.match(/^BTC|ETH|XMR|USDT$/)
    }

    function fc (amt, omit_currency, color_trick, do_pad) {
      var str
      var fstr
      amt > 999 ? fstr = '0.00' :
        amt > 99 ? fstr = '0.000' :
          amt > 9 ? fstr = '0.0000' :
            amt > 0.9 ? fstr = '0.00000' :
              amt > 0.09 ? fstr = '0.000000' :
                amt > 0.009 ? fstr = '0.0000000' :
                  fstr = '0.00000000'
      str = n(amt).format(fstr)
      if (do_pad) {
        s.max_fc_width = Math.max(s.max_fc_width, str.length)
        str = ' '.repeat(s.max_fc_width - str.length) + str
      }
      if (color_trick) {
        str = str
          .replace(/^(.*\.)(0*)(.*?)(0*)$/, function (_, m, m2, m3, m4) {
            return m.cyan + m2.grey + m3.yellow + m4.grey
          })
      }
      return str + (omit_currency ? '' : ' ' + s.currency)
    }

    function pct (ratio) {
      return (ratio >= 0 ? '+' : '') + n(ratio).format('0.00%')
    }

    function initBuffer (trade) {
      var d = tb(trade.time).resize(so.period_length)
      s.period = {
        period_id: d.toString(),
        size: so.period_length,
        time: d.toMilliseconds(),
        open: trade.price,
        high: trade.price,
        low: trade.price,
        close: trade.price,
        volume: 0,
        close_time: null
      }
    }

    function onTrade (trade) {
      s.period.high = Math.max(trade.price, s.period.high)
      s.period.low = Math.min(trade.price, s.period.low)
      s.period.close = trade.price
      s.period.volume += trade.size
      s.period.close_time = trade.time
      s.strategy.calculate(s)
      s.vol_since_last_blink += trade.size
    }

    function executeStop (do_sell_stop) {
      var stop_signal
      if (s.my_trades.length) {
        var last_trade = s.my_trades[s.my_trades.length - 1]
        s.last_trade_worth = last_trade.type === 'buy' ? (s.period.close - last_trade.price) / last_trade.price : (last_trade.price - s.period.close) / last_trade.price
        if (!s.acted_on_stop) {
          if (last_trade.type === 'buy') {
            if (do_sell_stop && s.sell_stop && s.period.close < s.sell_stop) {
              stop_signal = 'sell'
              console.log(('\nsell stop triggered at ' + pct(s.last_trade_worth) + ' trade worth\n').red)
            }
            else if (so.profit_stop_enable_pct && s.last_trade_worth >= (so.profit_stop_enable_pct / 100)) {
              s.profit_stop_high = Math.max(s.profit_stop_high || s.period.close, s.period.close)
              s.profit_stop = s.profit_stop_high - (s.profit_stop_high * (so.profit_stop_pct / 100))
            }
            if (s.profit_stop && s.period.close < s.profit_stop && s.last_trade_worth > 0) {
              stop_signal = 'sell'
              console.log(('\nprofit stop triggered at ' + pct(s.last_trade_worth) + ' trade worth\n').green)
            }
          }
          else {
            if (s.buy_stop && s.period.close > s.buy_stop) {
              stop_signal = 'buy'
              console.log(('\nbuy stop triggered at ' + pct(s.last_trade_worth) + ' trade worth\n').red)
            }
          }
        }
      }
      if (stop_signal) {
        s.signal = stop_signal
        s.acted_on_stop = true
      }
    }

    function syncBalance (cb) {
      if (so.mode !== 'live') {
        return cb()
      }

      s.exchange.getBalance({currency: s.currency, asset: s.asset}, function (err, balance) {
        if (err) return cb(err)
        s.balance = balance
        s.exchange.getQuote({product_id: s.product_id}, function (err, quote) {
          if (err) return cb(err)
			  
          if (!s.start_capital) {
            s.start_price = n(quote.ask).value()
            s.start_capital = n(s.balance.currency).add(n(s.balance.asset).multiply(quote.ask)).value()

            pushMessage('Balance ' + s.exchange.name.toUpperCase(), 'sync balance ' + s.start_capital + ' ' + s.currency  + '\n')
          }
		  
          s.asset_capital = n(s.balance.asset).multiply(quote.ask).value()
          cb()
        })
      })
    }

    function placeOrder (type, opts, cb) {
      if (!s[type + '_order']) {
        s[type + '_order'] = {
          price: opts.price,
          size: opts.size,
          orig_size: opts.size,
          remaining_size: opts.size,
          orig_price: opts.price,
          order_type: opts.is_taker ? 'taker' : so.order_type,
          cancel_after: so.cancel_after || 'day'
        }
      }
      var order = s[type + '_order']
      order.price = opts.price
      order.size = opts.size
      if (so.mode !== 'live') {
        if (!order.orig_time) order.orig_time = s.period.close_time
        order.time = s.period.close_time
        return cb(null, order)
      }
      else {
        order.product_id = s.product_id
        order.post_only = c.post_only
        msg('placing ' + type + ' order...')
        var order_copy = JSON.parse(JSON.stringify(order))
        s.exchange[type](order_copy, function (err, api_order) {
          if (err) return cb(err)
          s.api_order = api_order
          if (api_order.status === 'rejected') {
            if (api_order.reject_reason === 'post only') {
              // trigger immediate price adjustment and re-order
              msg('post-only ' + type + ' failed, re-ordering')
              return cb(null, null)
            }
            else if (api_order.reject_reason === 'balance') {
              // treat as a no-op.
              msg('not enough balance for ' + type + ', aborting')
              return cb(null, false)
            }
            else if (api_order.reject_reason === 'price') {
              // treat as a no-op.
              msg('invalid price for ' + type + ', aborting')
              return cb(null, false)
            }
            var err = new Error('\norder rejected')
            err.order = api_order
            return cb(err)
          }
          msg(type + ' order placed at ' + fc(order.price))
          order.order_id = api_order.id
          if (!order.time) {
            order.orig_time = new Date(api_order.created_at).getTime()
          }
          order.time = new Date(api_order.created_at).getTime()
          order.local_time = new Date().getTime()
          order.status = api_order.status
          //console.log('\ncreated ' + order.status + ' ' + type + ' order: ' + fa(order.size) + ' at ' + fc(order.price) + ' (total ' + fc(n(order.price).multiply(order.size)) + ')\n')
          function cancelOrder (do_reorder) {
            msg('cancelling order')
            s.exchange.cancelOrder({order_id: order.order_id, product_id: s.product_id}, function (err) {
              function checkHold () {
                s.exchange.getOrder({order_id: order.order_id, product_id: s.product_id}, function (err, api_order) {
                  if (api_order) {
                    s.api_order = api_order
                    if (api_order.filled_size) {
                      order.remaining_size = n(order.size).subtract(api_order.filled_size).format('0.00000000')
                    }
                  }
                  syncBalance(function () {
                    var on_hold
                    if (type === 'buy') on_hold = n(s.balance.currency).subtract(s.balance.currency_hold || 0).value() < n(order.price).multiply(order.remaining_size).value()
                    else on_hold = n(s.balance.asset).subtract(s.balance.asset_hold || 0).value() < n(order.remaining_size).value()
                    if (on_hold) {
                      // wait a bit for settlement
                      msg('funds on hold after cancel, waiting 5s')
                      setTimeout(checkHold, c.wait_for_settlement)
                    }
                    else {
                      cb(null, do_reorder ? null : false)
                    }
                  })
                })
              }
              checkHold()
            })
          }
          function checkOrder () {
            if (!s[type + '_order']) {
              // signal switched, stop checking order
              msg('signal switched during ' + type + ', aborting')
              return cancelOrder(false)
            }
            s.exchange.getOrder({order_id: order.order_id, product_id: s.product_id}, function (err, api_order) {
              if (err) return cb(err)
              s.api_order = api_order
              order.status = api_order.status
              if (api_order.reject_reason) order.reject_reason = api_order.reject_reason
              msg('order status: ' + order.status)
              if (api_order.status === 'done') {
                order.time = new Date(api_order.done_at).getTime()
                order.price = api_order.price || order.price // Use actual price if possible. In market order the actual price (api_order.price) could be very different from trade price
                executeOrder(order)
                return syncBalance(function () {
                  cb(null, order)
                })
              }
              if (order.status === 'rejected' && (order.reject_reason === 'post only' || api_order.reject_reason === 'post only')) {
                msg('post-only ' + type + ' failed, re-ordering')
                return cb(null, null)
              }
              if (order.status === 'rejected' && order.reject_reason === 'balance') {
                msg('not enough balance for ' + type + ', aborting')
                return cb(null, null)
              }
              if (new Date().getTime() - order.local_time >= so.order_adjust_time) {
                getQuote(function (err, quote) {
                  if (err) {
                    err.desc = 'could not execute ' + type + ': error fetching quote'
                    return cb(err)
                  }
                  var marked_price
                  if (type === 'buy') {
                    marked_price = n(quote.bid).subtract(n(quote.bid).multiply(so.markdown_buy_pct / 100)).format((so.currency_increment !== null) ? so.currency_increment : s.product.increment, Math.floor)
                    if (n(order.price).value() < marked_price) {
                      msg(marked_price + ' vs our ' + order.price)
                      cancelOrder(true)
                    }
                    else {
                      order.local_time = new Date().getTime()
                      setTimeout(checkOrder, so.order_poll_time)
                    }
                  }
                  else {
                    marked_price = n(quote.ask).add(n(quote.ask).multiply(so.markup_sell_pct / 100)).format((so.currency_increment !== null) ? so.currency_increment : s.product.increment, Math.ceil)
                    if (n(order.price).value() > marked_price) {
                      msg(marked_price + ' vs our ' + order.price)
                      cancelOrder(true)
                    }
                    else {
                      order.local_time = new Date().getTime()
                      setTimeout(checkOrder, so.order_poll_time)
                    }
                  }
                })
              }
              else {
                setTimeout(checkOrder, so.order_poll_time)
              }
            })
          }
          setTimeout(checkOrder, so.order_poll_time)
        })
      }
    }

    function getQuote (cb) {
      if (so.mode === 'sim' || so.mode === 'train') {
        return cb(null, {
          bid: s.period.close,
          ask: s.period.close
        })
      }
      else {
        s.exchange.getQuote({product_id: s.product_id}, function (err, quote) {
          if (err) return cb(err)
          s.quote = quote
          cb(null, quote)
        })
      }
    }

    function executeSignal (signal, _cb, size, is_reorder, is_taker) {

      // if s.signal
      // 1. sync balance
      // 2. get quote
      // 3. calculate size/price
      // 4. validate size against min/max sizes
      // 5. cancel old orders
      // 6. place new order
      // 7. record order ID and start poll timer
      // 8. if not filled after timer, repeat process
      // 9. if filled, record order stats

      var size, price
      delete s[(signal === 'buy' ? 'sell' : 'buy') + '_order']
      s.last_signal = signal
      if (!is_reorder && s[signal + '_order']) {
        if (is_taker) s[signal + '_order'].order_type = 'taker'
        // order already placed
        _cb && _cb(null, null)
        return
      }
      s.acted_on_trend = true
      var cb = function (err, order) {
        if (!order) {
          if (signal === 'buy') delete s.buy_order
          else delete s.sell_order
        }
        if (err) {
          if (_cb) {
            _cb(err)
          }
          else if (err.message.match(nice_errors)) {
            console.error((err.message + ': ' + err.desc).red)
          } else {
            memDump()
            console.error('\n')
            console.error(err)
            console.error('\n')
          }
        }
        else if (_cb) {
          _cb(null, order)
        }
      }
      syncBalance(function (err) {
        if (err) {
          msg('error getting balance')
        }
        getQuote(function (err, quote) {
          if (err) {
            err.desc = 'could not execute ' + signal + ': error fetching quote'
            return cb(err)
          }
          if (signal === 'buy') {
            price = n(quote.bid).subtract(n(quote.bid).multiply(so.markdown_buy_pct / 100)).format(s.product.increment, Math.floor)
            if (!size) {
              if (so.mode === 'live' || so.mode === 'paper') {
                var buy_pct = so.buy_pct
                if(so.buy_max_amt){ // account for held assets as buy_max
                  var adjusted_buy_max_amt = n(so.buy_max_amt).subtract(s.asset_capital).value()
                  var buy_max_as_pct = n(adjusted_buy_max_amt).divide(s.balance.currency).multiply(100).value()
                  buy_pct = buy_max_as_pct
                }else{ // account for held assets as %
                  var held_pct = n(s.asset_capital).divide(s.balance.currency).multiply(100).value()
                  var to_buy_pct = n(so.buy_pct).subtract(held_pct).value()
                  buy_pct = to_buy_pct
                }
                if (so.order_type === 'maker') {
                  size = n(s.balance.currency).multiply(buy_pct).divide(100).multiply(s.exchange.makerFee / 100).format('0.00000000')
                } else {
                  size = n(s.balance.currency).multiply(buy_pct).divide(100).multiply(s.exchange.takerFee / 100).format('0.00000000')
                }
                size = n(s.balance.currency).multiply(buy_pct).divide(100).subtract(size).divide(price).format('0.00000000')
              } else {
                size = n(s.balance.currency).multiply(so.buy_pct).divide(100).divide(price).format('0.00000000')
              }
            }
            if ((s.product.min_size && Number(size) >= Number(s.product.min_size)) || ('min_total' in s.product && s.product.min_total && n(size).multiply(price).value() >= Number(s.product.min_total))) {
              if (s.product.max_size && Number(size) > Number(s.product.max_size)) {
                size = s.product.max_size
              }
              if (s.buy_order && so.max_slippage_pct != null) {
                var slippage = n(price).subtract(s.buy_order.orig_price).divide(s.buy_order.orig_price).multiply(100).value()
                if (so.max_slippage_pct != null && slippage > so.max_slippage_pct) {
                  var err = new Error('\nslippage protection')
                  err.desc = 'refusing to buy at ' + fc(price) + ', slippage of ' + pct(slippage / 100)
                  return cb(err)
                }
              }
              if (n(s.balance.currency).subtract(s.balance.currency_hold || 0).value() < n(price).multiply(size).value() && s.balance.currency_hold > 0) {
                msg('buy delayed: ' + pct(n(s.balance.currency_hold || 0).divide(s.balance.currency).value()) + ' of funds (' + fc(s.balance.currency_hold) + ') on hold')
                return setTimeout(function () {
                  if (s.last_signal === signal) {
                    executeSignal(signal, cb, size, true)
                  }
                }, c.wait_for_settlement)
              }
              else {
                pushMessage('Buying ' + s.exchange.name.toUpperCase(), 'placing buy order at ' + fc(price) + ', ' + fc(quote.bid - Number(price)) + ' under best bid\n')
                doOrder()
              }
            }
            else {
              cb(null, null)
            }
          }
          else if (signal === 'sell') {
            price = n(quote.ask).add(n(quote.ask).multiply(so.markup_sell_pct / 100)).format(s.product.increment, Math.ceil)
            if (!size) {
              size = n(s.balance.asset).multiply(so.sell_pct / 100).format('0.00000000')
            }
            if ((s.product.min_size && Number(size) >= Number(s.product.min_size)) || (s.product.min_total && n(size).multiply(price).value() >= Number(s.product.min_total))) {
              if (s.product.max_size && Number(size) > Number(s.product.max_size)) {
                size = s.product.max_size
              }
              var sell_loss = s.last_buy_price ? (Number(price) - s.last_buy_price) / s.last_buy_price * -100 : null
              if (so.max_sell_loss_pct != null && sell_loss > so.max_sell_loss_pct) {
                var err = new Error('\nloss protection')
                err.desc = 'refusing to sell at ' + fc(price) + ', sell loss of ' + pct(sell_loss / 100)
                return cb(err)
              }
              else {
                if (s.sell_order && so.max_slippage_pct != null) {
                  var slippage = n(s.sell_order.orig_price).subtract(price).divide(price).multiply(100).value()
                  if (slippage > so.max_slippage_pct) {
                    var err = new Error('\nslippage protection')
                    err.desc = 'refusing to sell at ' + fc(price) + ', slippage of ' + pct(slippage / 100)
                    return cb(err)
                  }
                }
                if (n(s.balance.asset).subtract(s.balance.asset_hold || 0).value() < n(size).value()) {
                  msg('sell delayed: ' + pct(n(s.balance.asset_hold || 0).divide(s.balance.asset).value()) + ' of funds (' + fa(s.balance.asset_hold) + ') on hold')
                  return setTimeout(function () {
                    if (s.last_signal === signal) {
                      executeSignal(signal, cb, size, true)
                    }
                  }, c.wait_for_settlement)
                }
                else {
                  pushMessage('Selling ' + s.exchange.name.toUpperCase(), 'placing sell order at ' + fc(price) + ', ' + fc(Number(price) - quote.bid) + ' over best ask\n')
                  doOrder()
                }
              }
            }
            else {
              cb(null, null)
            }
          }
        })
      })
      function doOrder () {
        placeOrder(signal, {
          size: size,
          price: price,
          is_taker: is_taker,
          cancel_after: so.cancel_after || 'day'
        }, function (err, order) {
          if (err) {
            err.desc = 'could not execute ' + signal + ': error placing order'
            return cb(err)
          }
          if (!order) {
            if (order === false) {
              // not enough balance, or signal switched.
              msg('not enough balance, or signal switched, cancel ' + signal)
              return cb(null, null)
            }
            if (s.last_signal !== signal) {
              // order timed out but a new signal is taking its place
              msg('signal switched, cancel ' + signal)
              return cb(null, null)
            }
            // order timed out and needs adjusting
            msg(signal + ' order timed out, adjusting price')
            var remaining_size = s[signal + '_order'] ? s[signal + '_order'].remaining_size : size
            if (remaining_size !== size) {
              msg('remaining size: ' + remaining_size)
            }
            return executeSignal(signal, _cb, remaining_size, true)
          }
          cb(null, order)
        })
      }
    }

    function executeOrder (trade) {
      var price, fee = 0
      if (!so.order_type) {
        so.order_type = 'maker'
      }

      if (s.buy_order) {
        if (so.mode === 'live' || trade.price <= Number(s.buy_order.price)) {
          price = s.buy_order.price
          if (so.mode !== 'live') {
            s.balance.asset = n(s.balance.asset).add(s.buy_order.size).format('0.00000000')
            var total = n(price).multiply(s.buy_order.size)
            s.balance.currency = n(s.balance.currency).subtract(total).format('0.00000000')
            if (so.order_type === 'maker') {
              if (s.exchange.makerFee) {
                fee = n(s.buy_order.size).multiply(s.exchange.makerFee / 100).value()
                s.balance.asset = n(s.balance.asset).subtract(fee).format('0.00000000')
              }
            }
            if (so.order_type === 'taker') {
              price = n(s.buy_order.price).add(n(s.buy_order.price).multiply(so.avg_slippage_pct / 100)).format('0.00000000')
              if (s.exchange.takerFee) {
                fee = n(s.buy_order.size).multiply(s.exchange.takerFee / 100).value()
                s.balance.asset = n(s.balance.asset).subtract(fee).format('0.00000000')
              }
            }
          }
          s.action = 'bought'
          var my_trade = {
            order_id: trade.order_id,
            time: trade.time,
            execution_time: trade.time - s.buy_order.orig_time,
            slippage: n(price).subtract(s.buy_order.orig_price).divide(s.buy_order.orig_price).value(),
            type: 'buy',
            size: s.buy_order.orig_size,
            fee: fee,
            price: price,
            order_type: so.order_type || 'taker',
            cancel_after: so.cancel_after || 'day'
          }
          s.my_trades.push(my_trade)
          if (so.stats) {
            order_complete = '\nbuy order completed at ' + moment(trade.time).format('YYYY-MM-DD HH:mm:ss') + ':\n\n' + fa(my_trade.size) + ' at ' + fc(my_trade.price) + '\ntotal ' + fc(my_trade.size * my_trade.price) + '\n' + n(my_trade.slippage).format('0.0000%') + ' slippage (orig. price ' + fc(s.buy_order.orig_price) + ')\nexecution: ' + moment.duration(my_trade.execution_time).humanize() + '\n'
            console.log((order_complete).cyan)
            pushMessage('Buy ' + s.exchange.name.toUpperCase(), order_complete)
          }
          s.last_buy_price = my_trade.price
          delete s.buy_order
          delete s.buy_stop
          delete s.sell_stop
          if (so.sell_stop_pct) {
            s.sell_stop = n(price).subtract(n(price).multiply(so.sell_stop_pct / 100)).value()
          }
          delete s.profit_stop
          delete s.profit_stop_high
        }
      }
      else if (s.sell_order) {
        if (so.mode === 'live' || trade.price >= s.sell_order.price) {
          price = s.sell_order.price
          if (so.mode !== 'live') {
            s.balance.asset = n(s.balance.asset).subtract(s.sell_order.size).value()
            var total = n(price).multiply(s.sell_order.size)
            s.balance.currency = n(s.balance.currency).add(total).value()
            if (so.order_type === 'maker') {
              if (s.exchange.makerFee) {
                fee = n(s.sell_order.size).multiply(s.exchange.makerFee / 100).multiply(price).value()
                s.balance.currency = n(s.balance.currency).subtract(fee).format('0.00000000')
              }
            }
            if (so.order_type === 'taker') {
              price = n(s.sell_order.price).subtract(n(s.sell_order.price).multiply(so.avg_slippage_pct / 100)).format('0.00000000')
              if (s.exchange.takerFee) {
                fee = n(s.sell_order.size).multiply(s.exchange.takerFee / 100).multiply(price).value()
                s.balance.currency = n(s.balance.currency).subtract(fee).format('0.00000000')
              }
            }
          }
          s.action = 'sold'
          var my_trade = {
            order_id: trade.order_id,
            time: trade.time,
            execution_time: trade.time - s.sell_order.orig_time,
            slippage: n(s.sell_order.orig_price).subtract(price).divide(price).value(),
            type: 'sell',
            size: s.sell_order.orig_size,
            fee: fee,
            price: price,
            order_type: so.order_type
          }
          s.my_trades.push(my_trade)
          if (so.stats) {
            order_complete = '\nsell order completed at ' + moment(trade.time).format('YYYY-MM-DD HH:mm:ss') + ':\n\n' + fa(my_trade.size) + ' at ' + fc(my_trade.price) + '\ntotal ' + fc(my_trade.size * my_trade.price) + '\n' + n(my_trade.slippage).format('0.0000%') + ' slippage (orig. price ' + fc(s.sell_order.orig_price) + ')\nexecution: ' + moment.duration(my_trade.execution_time).humanize() + '\n'
            console.log((order_complete).cyan)
            pushMessage('Sell ' + s.exchange.name.toUpperCase(), order_complete)
          }
          s.last_sell_price = my_trade.price
          delete s.sell_order
          delete s.buy_stop
          if (so.buy_stop_pct) {
            s.buy_stop = n(price).add(n(price).multiply(so.buy_stop_pct / 100)).value()
          }
          delete s.sell_stop
          delete s.profit_stop
          delete s.profit_stop_high
        }
      }
    }

    function adjustBid (trade) {
      if (so.mode === 'live') return
      if (s.buy_order && trade.time - s.buy_order.time >= so.order_adjust_time) {
        executeSignal('buy', null, null, true)
      }
      else if (s.sell_order && trade.time - s.sell_order.time >= so.order_adjust_time) {
        executeSignal('sell', null, null, true)
      }
    }

    function writeReport (is_progress, blink_off) {
      // if ((so.mode === 'sim' || so.mode === 'train') && !so.verbose) {
      //   is_progress = true
      // }
      // else if (is_progress && typeof blink_off === 'undefined' && s.vol_since_last_blink) {
      //   s.vol_since_last_blink = 0
      //   setTimeout(function () {
      //     writeReport(true, true)
      //     s.screen.render()
      //   }, 200)
      //   setTimeout(function () {
      //     writeReport(true, false)
      //     s.screen.render()
      //   }, 400)
      //   setTimeout(function () {
      //     writeReport(true, true)
      //     s.screen.render()
      //   }, 600)
      //   // setTimeout(function () {
      //   //   writeReport(true, false)
      //   // s.screen.render()
      //   // }, 800)
      // }
      // readline.clearLine(process.stdout)
      // readline.cursorTo(process.stdout, 0)
      reportLine = ''
      reportLine += (moment(is_progress ? s.period.close_time : tb(s.period.time).resize(so.period_length).add(1).toMilliseconds()).format('YYYY-MM-DD HH:mm:ss')[is_progress && !blink_off ? 'bgBlue' : 'grey'])
      reportLine += ('  ' + fc(s.period.close, true, true, true) + ' ' + s.product_id.grey)
      if (s.lookback[0]) {
        var diff = (s.period.close - s.lookback[0].close) / s.lookback[0].close
        reportLine += (z(8, pct(diff), ' ')[diff >= 0 ? 'green' : 'red'])
      }
      else {
        reportLine += (z(9, '', ' '))
      }
      var volume_display = s.period.volume > 99999 ? abbreviate(s.period.volume, 2) : n(s.period.volume).format('0')
      volume_display = z(8, volume_display, ' ')
      if (volume_display.indexOf('.') === -1) volume_display = ' ' + volume_display
      reportLine += (volume_display[is_progress && blink_off ? 'cyan' : 'grey'])
      get('lib.rsi')(s, 'rsi', so.rsi_periods)
      if (typeof s.period.rsi === 'number') {
        var half = 5
        var bar = ''
        var stars = 0
        var rsi = s.period.rsi.toString()
        if (s.period.rsi >= 50) {
          stars = Math.min(Math.round(((s.period.rsi - 50) / 50) * half) + 1, half)
          bar += ' '.repeat(half - (rsi < 100 ? 3 : 4))
          bar += rsi.green + ' '
          bar += '+'.repeat(stars).green.bgGreen
          bar += ' '.repeat(half - stars)
        }
        else {
          stars = Math.min(Math.round(((50 - s.period.rsi) / 50) * half) + 1, half)
          bar += ' '.repeat(half - stars)
          bar += '-'.repeat(stars).red.bgRed
          bar += rsi.length > 1 ? ' ' : '  '
          bar += rsi.red
          bar += ' '.repeat(half - 3)
        }
        reportLine += (' ' + bar)
      }
      else {
        reportLine += (' '.repeat(11))
      }
      if (s.buy_order) {
        reportLine += (z(9, 'buying', ' ').green)
      }
      else if (s.sell_order) {
        reportLine += (z(9, 'selling', ' ').red)
      }
      else if (s.action) {
        reportLine += (z(9, s.action, ' ')[s.action === 'bought' ? 'green' : 'red'])
      }
      else if (s.signal) {
        reportLine += (z(9, s.signal || '', ' ')[s.signal ? s.signal === 'buy' ? 'green' : 'red' : 'grey'])
      }
      else if (s.last_trade_worth && !s.buy_order && !s.sell_order) {
        reportLine += (z(8, pct(s.last_trade_worth), ' ')[s.last_trade_worth > 0 ? 'green' : 'red'])
      }
      else {
        reportLine += (z(9, '', ' '))
      }
      var orig_capital = s.orig_capital || s.start_capital
      var orig_price = s.orig_price || s.start_price
      if (orig_capital) {
        var asset_col = n(s.balance.asset).format(s.asset === 'BTC' ? '0.00000' : '0.00000000') + ' ' + s.asset
        s.asset_col_width = Math.max(asset_col.length + 1, s.asset_col_width)
        reportLine += (z(s.asset_col_width, asset_col, ' ').white)
        var currency_col = n(s.balance.currency).format(isFiat() ? '0.00' : '0.00000000') + ' ' + s.currency
        s.currency_col_width = Math.max(currency_col.length + 1, s.currency_col_width)
        reportLine += (z(s.currency_col_width, currency_col, ' ').yellow)
        var consolidated = n(s.balance.currency).add(n(s.period.close).multiply(s.balance.asset)).value()
        var profit = (consolidated - orig_capital) / orig_capital
        reportLine += (z(8, pct(profit), ' ')[profit >= 0 ? 'green' : 'red'])
        var buy_hold = s.period.close * (orig_capital / orig_price)
        var over_buy_hold_pct = (consolidated - buy_hold) / buy_hold
        reportLine += (z(8, pct(over_buy_hold_pct), ' ')[over_buy_hold_pct >= 0 ? 'green' : 'red'])
      }

      if (s.strategy.onReport) {
        var cols = s.strategy.onReport.call(s.ctx, s)
        cols.forEach(function (col) {
          reportLine += (col)
        })
      }
      if (!is_progress) {
        reportLine += ('\n')
      }
      s.recent_periods.log(reportLine)
    }

    return {
      writeHeader: function () {
        s.recent_periods.setLabel([
          z(16, 'DATE', ' ').green,
          z(10, 'PRICE', ' ').green,
          z(10, 'SELECTOR', ' ').green,
          z(8, 'DIFF', ' ').green,
          z(9, 'VOL', ' ').green,
          z(8, 'RSI', ' ').green,
          z(14, 'ACTIONS', ' ').green,
          z(10, 'ASSET', ' ').green,
          z(14, 'CURRENCY', ' ').green,
          z(9, 'PROFIT', ' ').green,
          z(9, 'vsHODL', ' ').green,
          z(10, 'STRATEGY COLUMNS', ' ').green
        ].join(''))
      },
      update: function (trades, is_preroll, cb) {
        if (typeof is_preroll === 'function') {
          cb = is_preroll
          is_preroll = false
        }
        trades.sort(function (a, b) {
          if (a.time < b.time) return -1
          if (a.time > b.time) return 1
          return 0
        })
        var tasks = trades.map(function (trade) {
          return function (done) {
            if (s.period && trade.time < s.period.time) {
              return done()
            }
            var period_id = tb(trade.time).resize(so.period_length).toString()
            var day = tb(trade.time).resize('1d')
            if (s.last_day && s.last_day.toString() && day.toString() !== s.last_day.toString()) {
              s.day_count++
            }
            s.last_day = day
            if (!s.period) {
              initBuffer(trade)
            }
            s.in_preroll = is_preroll || (so.start && trade.time < so.start)
            if (period_id !== s.period.period_id) {
              s.strategy.onPeriod.call(s.ctx, s, function () {
                s.acted_on_stop = false
                if (!s.in_preroll && !so.manual) {
                  executeStop(true)
                  if (s.signal) {
                    executeSignal(s.signal)
                  }
                }
                writeReport()
                s.lookback.unshift(s.period)
                s.action = null
                s.signal = null
                initBuffer(trade)
                withOnPeriod()
              })
            }
            else {
              withOnPeriod()
            }
            function withOnPeriod () {
              onTrade(trade)
              if (!s.in_preroll) {
                if (so.mode !== 'live' && !s.start_capital) {
                  s.start_capital = 0
                  s.start_price = trade.price
                  if (so.asset_capital) {
                    s.start_capital += so.asset_capital * s.start_price
                  }
                  if (so.currency_capital) {
                    s.start_capital += so.currency_capital
                  }
                }
                if (!so.manual) {
                  executeStop()
                  if (s.signal) {
                    executeSignal(s.signal)
                    s.signal = null
                  }
                }
                if (so.mode !== 'live') {
                  adjustBid(trade)
                  executeOrder(trade)
                }
              }
              s.last_period_id = period_id
              setImmediate(done)
            }
          }
        })
        series(tasks, cb)
      },
      exit: function (cb) {
        cb()
      },
      executeSignal: executeSignal,
      writeReport: writeReport,
      syncBalance: syncBalance,
      formatCurrency: fc,
      formatAsset: fa,
      createTextUI: createTextUI,
      displayPopup: displayPopup,
      printTrade: printTrade
    }
  }
}
