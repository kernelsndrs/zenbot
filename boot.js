let glob = require('glob')
  , mongoDB = require('mongodb')

module.exports = function (cb) {
  let zenbot = require('./')()
  let c = getConfiguration()
  addDefaultsIfNotInConf(c)
  zenbot.set('zenbot:conf', c)
  setupMongo()
  function setupMongo() {

    var authStr = '', authMechanism;

    if(c.mongo.username){
      authStr = encodeURIComponent(c.mongo.username)

      if(c.mongo.password) authStr += ':' + encodeURIComponent(c.mongo.password)

      authStr += '@'

      // authMechanism could be a conf.js parameter to support more mongodb authentication methods
      authMechanism = 'DEFAULT'
    }

    var u = 'mongodb://' + authStr + c.mongo.host + ':' + c.mongo.port + '/' + c.mongo.db + '?' + (c.mongo.replicaSet ? '&replicaSet=' + c.mongo.replicaSet : '' ) + (authMechanism ? '&authMechanism=' + authMechanism : '' )
    mongoDB.MongoClient.connect(u, function (err, db) {
      if (err) {
        zenbot.set('zenbot:db.mongo', null)
        console.error('WARNING: MongoDB Connection Error: ', err)
        console.error('WARNING: without MongoDB some features (such as backfilling/simulation) may be disabled.')
        console.error('Attempted authentication string: ' + u);
        return loadCodemaps()
      }
      zenbot.set('zenbot:db.mongo', db)
      loadCodemaps()
    })
  }
  function loadCodemaps () {
    //searches all directorys in {workingdir}/extensions/ for files called '_codemap.js'
    glob('extensions/**/_codemap.js', {cwd: __dirname, absolute: true}, function (err, results) {
      if (err) return cb(err)
      results.forEach(function (result) {
        var ext = require(result) //load the _codemap for the extension
        zenbot.use(ext)           //load the extension into zenbot
      })
      cb(null, zenbot)
    })
  }
  function addDefaultsIfNotInConf(conf){

    var defaults = require('./conf-sample')
    Object.keys(defaults).forEach(function (k) {
      if (typeof conf[k] === 'undefined') {
        conf[k] = defaults[k]
      }
    })
  }
  function getConfiguration() {
    var conf = undefined

    try {
      var _allArgs = process.argv.slice();
      var found = false

      while (!found && _allArgs.length > 0) {
        found = (_allArgs.shift() == '--conf');
      }

      if (found) {
        try {
          conf = require(_allArgs[0])
        } catch (ee) {
          //command line conf not found
          console.log('Fall back to conf.js, ' + ee)
          conf = require('./conf')
        }
      } else {
        conf = require('./conf')
      }
    }
    catch (e) {
      // conf.js not found
      console.log('Fall back to sample-conf.js, ' + e)
      conf = {}
    }

    return conf
  }
}
