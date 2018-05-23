
const D = require('../D').class
const Device = require('./IEsDevice').class

const ADDRESSES = [
  '3141317A5031655035514765666932444D505466544C35534C6D7637446976664E61',
  '31457a3639536e7a7a6d65506d5a58335770457a4d4b54726342463267704e513535',
  '31585054674452684e3852466e7a6e69574364646f624439694b5a617472764834',
  '31347245374a717934613650323771574343736e676b556642787465765a68504842',
  '314d38733253356267417a53537a5654654c377a7275764d504c767a536b45417576'
]

const MockDevice = function () {
  this.currentAddressIndex = 0
}
module.exports = {class: MockDevice}

MockDevice.prototype = new Device()
MockDevice.prototype.listenPlug = function (callback) {
  setTimeout(() => {
    callback(D.ERROR_NO_ERROR, D.STATUS_PLUG_IN)
    // setTimeout(function () {
    //   callback(D.ERROR_NO_ERROR, D.STATUS_PLUG_IN)
    // }, 2000)
  }, 500)
}

MockDevice.prototype.sendAndReceive = async function (apdu) {
  if (D.arrayBufferToHex(apdu) === '0003000000') {
    return D.hexToArrayBuffer('010100')
  }
  if (D.arrayBufferToHex(apdu) === '00FF000000') {
    return D.hexToArrayBuffer('010102')
  }
  if (D.arrayBufferToHex(apdu) === '0023000000') {
    return D.hexToArrayBuffer(ADDRESSES[this.currentAddressIndex])
  }
  if (D.arrayBufferToHex(apdu) === '0023010000') {
    return D.hexToArrayBuffer(ADDRESSES[++this.currentAddressIndex % ADDRESSES.length])
  }
  throw D.ERROR_DEVICE_COMM
}
