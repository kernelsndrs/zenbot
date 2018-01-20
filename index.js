let codemap = require('codemap')

module.exports = function () {
  let rootMap = {
    _maps: [require('./_codemap')],

    'get': function container (get, set) {
      return get
    },
    'set': function container (get, set) {
      return set
    },
    'use': function container (get, set) {
      return function use () {
        [].slice.call(arguments).forEach(function (arg) {
          instance.parseMap(arg)
        })
        instance.validatePathCache()
      }
    }
  }
  let instance = codemap(rootMap)
  return instance.export()
}

module.exports.version = require('./package.json').version
