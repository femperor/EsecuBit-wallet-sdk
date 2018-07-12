
import bitPony from 'bitpony'
import base58check from 'bs58check'
import createKeccakHash from 'keccak'

const D = {
  // wallet status
  status: {
    plugIn: 1,
    initializing: 2,
    syncing: 3,
    syncFinish: 10,
    plugOut: 99
  },

  error: {
    succeed: 0,

    noDevice: 101,
    deviceComm: 102,
    deviceConnectFailed: 103,
    deviceDeriveLargerThanN: 104,
    deviceProtocol: 105,
    handShake: 106,
    needPressKey: 107, // sleep after long time idle
    userCancel: 108,

    databaseOpenFailed: 201,
    databaseExecFailed: 202,

    lastAccountNoTransaction: 301,
    accountHasTransactions: 302,

    networkUnavailable: 401,
    networkNotInitialized: 402,
    networkProviderError: 403,

    balanceNotEnough: 501,
    txNotFound: 502,

    invalidAddress: 601,
    noAddressCheckSum: 602, // for eth
    invalidAddressChecksum: 603,

    notImplemented: 10000,
    unknown: 10001,
    coinNotSupported: 10002
  },

  coin: {
    main: {
      btc: 'btc',
      eth: 'eth'
    },
    test: {
      btcTestNet3: 'btc_testnet3',
      ethRinkeby: 'eth_rinkeby'
    }
  },

  address: {
    external: 'external',
    change: 'change',

    checkBtcAddress (address) {
      let buffer
      try {
        buffer = base58check.decode(address)
      } catch (e) {
        console.warn(e)
        throw D.error.invalidAddress
      }
      if (buffer.length !== 21) throw D.error.invalidAddress

      let network = buffer.readUInt8(0)
      switch (network) {
        case 0: // main net P2PKH
        case 0x05: // main net P2SH
          if (D.test.coin) throw D.error.invalidAddress
          break
        case 0x6f: // test net P2PKH
        case 0xc4: // test net P2SH
          if (!D.test.coin) throw D.error.invalidAddress
          break
        default:
          throw D.error.invalidAddress
      }
      return true
    },

    checkEthAddress (address) {
      let checksum = D.address.toEthChecksumAddress(address)
      if (checksum === address) {
        return true
      }
      if (address.startsWith('0x')) address = address.slice(2)
      if (address.toUpperCase() === address || address.toLowerCase() === address) {
        throw D.error.noAddressCheckSum
      }
      throw D.error.invalidAddress
    },

    keccak256 (data) {
      if (data instanceof String) {
        if (data.startsWith('0x')) {
          data = data.slice(2)
        }
        data = D.toBuffer(data)
      }
      if (data instanceof ArrayBuffer) {
        data = Buffer.from(data)
      }
      return '0x' + createKeccakHash('keccak256').update(data).digest('hex')
    },

    /**
     * Copied from web3.utils.toChecksumAddress and modified.
     *
     * Converts to a checksum address
     *
     * @method toEthChecksumAddress
     * @param {String} address the given HEX address
     * @return {String}
     */
    toEthChecksumAddress (address) {
      if (address === undefined) return ''
      if (!/^(0x)?[0-9a-f]{40}$/i.test(address)) throw D.error.invalidAddress

      address = address.toLowerCase().replace(/^0x/i, '')
      let addressHash = D.address.keccak256(address).replace(/^0x/i, '')
      let checksumAddress = '0x'
      for (let i = 0; i < address.length; i++) {
        // If ith character is 9 to f then make it uppercase
        if (parseInt(addressHash[i], 16) > 7) {
          checksumAddress += address[i].toUpperCase()
        } else {
          checksumAddress += address[i]
        }
      }
      return checksumAddress
    },

    /**
     * convert string type address to ArrayBuffer
     */
    toBuffer (address) {
      // TODO refactor all ArrayBuffer to Buffer
      // TODO throw Error instead of int
      if (address.startsWith('0x')) {
        // eth
        return D.toBuffer(address.slice(2))
      } else {
        // bitcoin
        let buffer
        try {
          buffer = base58check.decode(address)
        } catch (e) {
          console.warn(e)
          throw D.error.invalidAddress
        }
        if (buffer.length !== 21) throw D.error.invalidAddress
        return new Uint8Array(buffer.slice(1)).buffer
      }
    },

    toString (address) {
      if (address.byteLength === 20) {
        // eth
        return D.address.toEthChecksumAddress(address)
      } else if (address.byteLength === 21) {
        // bitcoin
        return base58check.encode(Buffer.from(address))
      } else {
        throw D.error.coinNotSupported
      }
    },

    path: {
      /**
       * convert string type path to ArrayBuffer
       */
      toBuffer (path) {
        let level = path.split('/').length
        if (path[0] === 'm') level--
        let buffer = new Uint8Array(level * 4)
        path.split('/').forEach((index, i) => {
          if (i === 0 && index === 'm') return
          let indexInt = 0
          if (index[index.length - 1] === "'") {
            indexInt += 0x80000000
            index = index.slice(0, -1)
          }
          indexInt += parseInt(index)
          buffer[4 * (i - 1)] = indexInt >> 24
          buffer[4 * (i - 1) + 1] = indexInt >> 16
          buffer[4 * (i - 1) + 2] = indexInt >> 8
          buffer[4 * (i - 1) + 3] = indexInt
        })
        return buffer.buffer
      }
    }
  },

  tx: {
    direction: {
      in: 'in',
      out: 'out'
    },
    matureConfirms: {
      btc: 6,
      eth: 6
    },

    getMatureConfirms (coinType) {
      if (D.isBtc(coinType)) {
        return D.tx.matureConfirms.btc
      } else if (D.isEth(coinType)) {
        return D.tx.matureConfirms.eth
      } else {
        throw D.error.coinNotSupported
      }
    }
  },

  utxo: {
    status: {
      unspent_pending: 'unspent_pending',
      unspent: 'unspent',
      spent_pending: 'spent_pending',
      spent: 'spent'
    }
  },

  fee: {
    fastest: 'fastest',
    fast: 'fast',
    normal: 'normal',
    economic: 'economic'
  },

  unit: {
    btc: {
      BTC: 'BTC',
      mBTC: 'mBTC',
      santoshi: 'santoshi'
    },
    eth: {
      ETH: 'ETH',
      Ether: 'Ether',
      GWei: 'GWei',
      Wei: 'Wei'
    },
    legal: {
      USD: 'USD',
      EUR: 'EUR',
      CNY: 'CNY',
      JPY: 'JPY'
    }
  },

  isBtc (coinType) {
    return coinType.includes('btc')
  },

  isEth (coinType) {
    return coinType.includes('eth')
  },

  suppertedLegals () {
    return Object.values(this.unit.legal)
  },

  suppertedCoinTypes () {
    return Object.values(D.test.coin ? D.coin.test : D.coin.main)
  },

  recoverCoinTypes () {
    return D.suppertedCoinTypes()
  },

  convertValue (coinType, value, fromType, toType) {
    let convertBtc = (value, fromType, toType) => {
      let santoshi
      switch (fromType) {
        case D.unit.btc.BTC: { santoshi = value * 100000000; break }
        case D.unit.btc.mBTC: { santoshi = value * 100000; break }
        case D.unit.btc.santoshi: { santoshi = value; break }
        default: throw D.error.unknown
      }
      switch (toType) {
        case D.unit.btc.BTC: return Number(santoshi / 100000000)
        case D.unit.btc.mBTC: return Number(santoshi / 100000)
        case D.unit.btc.santoshi: return Number(santoshi)
      }
    }
    let convertEth = (value, fromType, toType) => {
      let wei
      switch (fromType) {
        case D.unit.eth.ETH:
        case D.unit.eth.Ether: { wei = value * 1000000000000000000; break }
        case D.unit.eth.GWei: { wei = value * 1000000000; break }
        case D.unit.eth.Wei: { wei = value; break }
        default: throw D.error.unknown
      }
      switch (toType) {
        case D.unit.eth.ETH:
        case D.unit.eth.Ether: return Number(wei / 1000000000000000000)
        case D.unit.eth.GWei: return Number(wei / 1000000000)
        case D.unit.eth.Wei: return Number(wei)
      }
    }
    switch (coinType) {
      case D.coin.main.btc:
      case D.coin.test.btcTestNet3:
        return convertBtc(value, fromType, toType)
      case D.coin.main.eth:
      case D.coin.test.ethRinkeby:
        return convertEth(value, fromType, toType)
      default:
        throw D.error.coinNotSupported
    }
  },

  wait (timeMill) {
    return new Promise(resolve => setTimeout(resolve, timeMill))
  },

  dispatch (func) {
    setTimeout(func, 0)
  },

  toHex (array) {
    const hexChars = '0123456789abcdef'
    let hexString = new Array(array.byteLength * 2)
    let intArray = new Uint8Array(array)

    for (let i = 0; i < intArray.byteLength; i++) {
      hexString[2 * i] = hexChars.charAt((intArray[i] >> 4) & 0x0f)
      hexString[2 * i + 1] = hexChars.charAt(intArray[i] & 0x0f)
    }
    return hexString.join('')
  },

  getRandomHex (length) {
    let hex = ''
    const possible = '0123456789abcdef'
    for (let i = 0; i < length; i++) hex += possible.charAt(Math.floor(Math.random() * possible.length))
    return hex
  },

  toBuffer (hex) {
    hex = hex.replace(/\s+/g, '')
    const hexChars = '0123456789ABCDEFabcdef'
    let result = new ArrayBuffer(hex.length / 2)
    let res = new Uint8Array(result)
    for (let i = 0; i < hex.length; i += 2) {
      if (hexChars.indexOf(hex.substring(i, i + 1)) === -1) break
      res[i / 2] = parseInt(hex.substring(i, i + 2), 16)
    }
    return result
  },

  getCoinIndex (coinType) {
    switch (coinType) {
      case D.coin.main.btc:
      case D.coin.test.btcTestNet3:
        return 0
      case D.coin.main.eth:
      case D.coin.test.ethRinkeby:
        return 60
      default:
        throw D.error.coinNotSupported
    }
  },

  makeBip44Path (coinType, accountIndex, type, addressIndex) {
    return "m/44'/" +
      D.getCoinIndex(coinType) + "'/" +
      accountIndex + "'/" +
      (type === D.address.external ? 0 : 1) +
      (addressIndex === undefined ? '' : ('/' + addressIndex))
  },

  /**
   * @return format tx
   * {
   *   hash: hex string,
   *   length: int,
   *   in_count: int.
   *   in: [{hash, index, scriptSig, script_len, sequence}, ...]
   *   out_count: int,
   *   out: [{amount, scriptPubKey, script_len}, ...]
   *   lock_time: long
   * }
   */
  parseBitcoinRawTx (hexTx) {
    return bitPony.tx.read(hexTx)
  },

  /**
   * shallow copy
   * @param object
   */
  copy (object) {
    return JSON.parse(JSON.stringify(object))
  },

  // array buffer operation
  buffer: {
    copy (src, srcOffset, dest, destOffset, length) {
      if (typeof src === 'string') {
        src = D.toBuffer(src)
      }
      if (typeof dest === 'string') {
        dest = D.toBuffer(dest)
      }
      let srcView = src instanceof Uint8Array ? src : new Uint8Array(src)
      let destView = dest instanceof Uint8Array ? dest : new Uint8Array(dest)
      length = length || srcView.length - srcOffset
      srcView.slice(srcOffset, srcOffset + length).map((value, i) => { destView[i + destOffset] = value })
    },

    concat (a, b) {
      if (typeof a === 'string') {
        a = D.toBuffer(a)
      }
      if (typeof b === 'string') {
        b = D.toBuffer(b)
      }
      let c = new ArrayBuffer(a.byteLength + b.byteLength)
      let av = a instanceof Uint8Array ? a : new Uint8Array(a)
      let bv = b instanceof Uint8Array ? b : new Uint8Array(b)
      let cv = c instanceof Uint8Array ? c : new Uint8Array(c)
      cv.set(av, 0)
      cv.set(bv, av.length)
      return c
    },

    slice (src, start, end) {
      if (typeof src === 'string') {
        src = D.toBuffer(src)
      }
      let srcv = src instanceof Uint8Array ? src : new Uint8Array(src)
      srcv = srcv.slice(start, end)
      let ret = new Uint8Array(srcv.length)
      ret.set(srcv, 0)
      return ret.buffer
    }
  },

  test: {
    coin: false,
    data: false,
    networkRequest: false,
    jsWallet: false,
    sync: false,
    mockDevice: false,
    // TODO remove when publish
    // sync used for test sync
    syncWalletId: 'aa49342d805682f345135afcba79ffa7d50c2999944b91d88e01e1d38b80ca63',
    syncSeed: 'aa49342d805682f345135afcba79ffa7d50c2999944b91d88e01e1d38b80ca63',
    // sync used for test transaction
    txWalletId: '00000000805682f345135afcba79ffa7d50c2999944b91d88e01e1d300000000',
    txSeed: '00000000805682f345135afcba79ffa7d50c2999944b91d88e01e1d300000000',

    generateSeed () {
      return D.getRandomHex(64)
    }
  }
}
export default D
