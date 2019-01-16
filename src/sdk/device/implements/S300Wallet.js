
import D from '../../D'
import rlp from 'rlp'
import BigInteger from 'bigi'
import bitPony from 'bitpony'
import {Buffer} from 'buffer'
import createHash from 'create-hash'
import base58 from 'bs58'
import FcBuffer from './protocol/EosFcBuffer'
import HandShake from './protocol/HandShake'

const getAppId = (coinType) => {
  if (!coinType) {
    return '010102'
  } else if (D.isBtc(coinType)) {
    return '020002'
  } else if (D.isEth(coinType)) {
    return '023C02'
  } else if (D.isEos(coinType)) {
    return '02C202'
  } else {
    console.warn('unknown coinType for appId', coinType)
    throw D.error.coinNotSupported
  }
}

// rewrite _containKeys to make empty value available, so we can use it to build presign tx
// noinspection JSPotentiallyInvalidConstructorUsage
bitPony.prototype._containKeys = function (keys) {
  for (let i of keys) {
    if (this.data[i] === null) {
      throw new Error('key ' + this.type + '.' + i + ' can not be null ' + this.data[i])
    }
  }
}

export default class S300Wallet {
  constructor (transmitter) {
    this._transmitter = transmitter
    this._currentApp = null
    this._allEnc = false
  }

  async init () {
    console.log('S300Wallet init')
    this._currentApp = null
    await this._transmitter.reset()

    this._handShake = new HandShake(null, HandShake.SM2)
    let walletId = D.test.coin ? '01' : '00'
    walletId += D.test.jsWallet ? '01' : '00'
    walletId += (await this.getWalletId()).toString('hex')

    // CoreWallet will try S300Wallet first before try NetBankWallet
    // won't enable enc apdu for fast failing S300Wallet when it's a NetBankWallet
    this._allEnc = true
    // we do handshake here to make other commands (e.g. getAddress) looks more quickly
    // 1. some other program may try to send command to device
    // 2. in some limit situation, device is not stable yet
    // try up to 3 times
    await this._doHandShake()
      .catch(() => this._doHandShake())
      .catch(() => this._doHandShake())
    return {walletId: walletId}
  }

  async _select (coinType) {
    let appId = getAppId(coinType)
    if (this._currentApp === appId) return
    await this.sendApdu('00A4040008B000000000' + appId, false)
    this._currentApp = appId
  }

  async getWalletInfo () {
    let cosVersion = await this._getCosVersion()
    return {
      sdk_version: D.sdkVersion,
      cos_version: cosVersion
    }
  }

  async getWalletId () {
    return this.sendApdu('8060000000', false)
  }

  async _getCosVersion () {
    console.warn('get version not supported yet!')
    return 'get version not supported yet'
  }

  async getPublicKey (coinType, path, isShowing = false) {
    // see getAddress
    let flag = isShowing ? 0x02 : 0x00

    let apduHead = Buffer.from('804600001505', 'hex')
    let pathBuffer = D.address.path.toBuffer(path)
    let apdu = Buffer.concat([apduHead, pathBuffer])
    apdu[3] = flag
    let publicKey = await this.sendApdu(apdu, false, coinType)
    return publicKey.toString('hex')
  }

  async getAddress (coinType, path, isShowing = false, isStoring = false) {
    // bit 0: 0 not save on key / 1 save on key
    // bit 1: 0 not show on key / 1 show on key
    // bit 2: 0 public key / 1 address
    // bit 3: 0 uncompressed / 1 compressed
    // if bit2 == 0, bit0 == bit1 == 0
    let flag = 0
    flag += isStoring ? 0x01 : 0x00
    flag += isShowing ? 0x02 : 0x00
    flag += 0x04
    flag += !D.isEth(coinType) && 0x08 // compressed if not ETH

    let apduHead = Buffer.from('804600001505', 'hex')
    let pathBuffer = D.address.path.toBuffer(path)
    let apdu = Buffer.concat([apduHead, pathBuffer])
    apdu[3] = flag

    let response = await this.sendApdu(apdu, false, coinType)
    let address = String.fromCharCode.apply(null, new Uint8Array(response))
    // device only return mainnet address
    if (coinType === D.coin.test.btcTestNet3) {
      let addressBuffer = D.address.toBuffer(address)
      addressBuffer = Buffer.concat([Buffer.from('6F', 'hex'), addressBuffer])
      address = D.address.toString(coinType, addressBuffer)
    }
    return address
  }

  async getPermissions (coinType, accountIndex) {
    if (!D.isEos(coinType)) {
      console.warn('getPermissions only supports EOS', coinType)
      throw D.error.coinNotSupported
    }
    if (accountIndex < 0x80000000 || accountIndex > 0xFFFFFFFF) {
      console.warn('accountIndex out of range', accountIndex)
      throw D.error.invalidParams
    }

    let apdu = Buffer.from('8050000004' + accountIndex.toString(), 'hex')
    let response = await this.sendApdu(apdu, true, coinType)
    let parts = String.fromCharCode.apply(null, new Uint8Array(response)).split('\n')
    // remove the head and the tail
    parts = parts.slice(1, parts.length - 1)
    let permissions = []

    let index = 0
    while (index < parts.length) {
      let name = parts[index++]
      name = name.slice(0, name.length - 1)
      let key = parts[index++]
      let permission = permissions.find(p => p.name === name)
      if (!permission) {
        permissions.push({name: name, keys: [{publicKey: key}]})
      } else {
        permission.keys.push({publicKey: key})
      }
    }
    return permissions
  }

  async addPermissions (coinType, permissions, showingCallback) {
    if (!D.isEos(coinType)) {
      console.warn('addPermissions only supports EOS', coinType)
      throw D.error.coinNotSupported
    }

    // 8052 0000 len count[1] {actor[8] name[8] path[20]}...
    let apduHead = Buffer.from('805200000000', 'hex')
    let datas = Buffer.alloc(0)
    let count = 0
    let updatePermissions = async () => {
      D.dispatch(() => showingCallback(D.error.succeed,
        D.status.syncingNewEosWillConfirmPermissions, permissions.slice(0, count)))
      let apdu = Buffer.concat([apduHead, datas])
      apdu[0x04] = 1 + datas.length
      apdu[0x05] = count
      try {
        await this.sendApdu(apdu, true, coinType)
      } catch (e) {
        console.warn('add permissions failed', permissions.slice(0, count))
        D.dispatch(() => showingCallback(D.error.userCancel,
          D.status.syncingNewEosWillConfirmPermissions, permissions.slice(0, count)))
        throw D.error.userCancel
      }
      count = 0
      datas = Buffer.alloc(0)
    }

    for (let pm of permissions) {
      let data = Buffer.concat([
        FcBuffer.name.toBuffer(pm.address), // actor
        FcBuffer.name.toBuffer(pm.type), // name
        D.address.path.toBuffer(pm.path) // path
      ])

      if (datas.length + data.length > 0xff) {
        await updatePermissions()
      }

      datas = Buffer.concat([datas, data])
      count++
    }

    if (datas.length !== 0) {
      await updatePermissions()
    }
  }

  /**
   * tx:
   * btc:
   * {
   *   inputs: [{
   *     address: base58 string,
   *     path: string,
   *     txId: hex string,
   *     index: number,
   *     script: string,
   *   }],
   *   outputs: [{
   *     address: base58 string,
   *     value: number
   *   }]
   *   changePath: string,
   * }
   *
   * eth:
   * {
   *   input: {
   *     address: 0x string,
   *     path: string,
   *   ],
   *   output: {
   *     address: 0x string,
   *     value: number
   *   },
   *   nonce: number,
   *   gasPrice: 0x string,
   *   gasLimit: 0x string,
   *   data: 0x string,
   * }
   */
  async signTransaction (coinType, tx) {
    // for btc and eth
    let buildSign = (path, changePath, msg) => {
      // 8048 state flag length C0 u1PathNum pu1Path C1 u1ChangePathNum pu1ChangePath C2 xxxx pu1Msg
      let dataLength =
        2 + path.length +
        (changePath ? (2 + changePath.length) : 2) +
        3 + msg.length

      let data = Buffer.allocUnsafe(dataLength)
      let index = 0
      data[index++] = 0xC0
      data[index++] = path.length / 4
      path.copy(data, index)
      index += path.length

      data[index++] = 0xC1
      data[index++] = changePath ? (changePath.length / 4) : 0
      if (changePath) changePath.copy(data, index)
      index += changePath ? changePath.length : 0

      data[index++] = 0xC2
      data[index++] = msg.length >> 8
      data[index++] = msg.length
      msg.copy(data, index)

      return data
    }

    let sendSign = async (data, isCompressed) => {
      let compressChange = 0x08
      let response
      if (data.length <= 0xFF) {
        let apduHead = Buffer.from('8048030000', 'hex')
        isCompressed && (apduHead[3] |= compressChange)
        apduHead[4] = data.length
        response = await this.sendApdu(Buffer.concat([apduHead, data]), true, coinType)
      } else {
        let remainLen = data.length
        // devide tx to sign due to wallet command length limit
        while (true) {
          if (remainLen <= 0xFF) {
            let apduHead = Buffer.from('8048020000', 'hex')
            apduHead[3] |= compressChange
            apduHead[4] = remainLen
            let offset = data.length - remainLen
            response = await this.sendApdu(Buffer.concat([apduHead, data.slice(offset, data.length)]), true, coinType)
            break
          } else if (remainLen === data.length) {
            // first package
            let apduHead = Buffer.from('80480100FF', 'hex')
            await this.sendApdu(Buffer.concat([apduHead, data.slice(0, 0xFF)]), true)
          } else {
            // middle package
            let apduHead = Buffer.from('80480000FF', 'hex')
            apduHead[3] |= compressChange
            let offset = data.length - remainLen
            await this.sendApdu(Buffer.concat([apduHead, data.slice(offset, offset + 0xFF)]), true, coinType)
          }
          remainLen -= 0xFF
        }
      }
      return response
    }

    let parseSignResponse = (coinType, response) => {
      let remain = 0
      if (D.isEos(coinType)) {
        remain = response[0]
        response = response.slice(0, response.length)
      }

      let r = response.slice(0, 32)
      let s = response.slice(32, 64)
      let pubKey = response.slice(64, 128)
      let v = response[128] % 2

      let n = BigInteger.fromHex('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')
      const N_OVER_TWO = n.shiftRight(1)
      let sInt = BigInteger.fromBuffer(s)
      if (sInt.compareTo(N_OVER_TWO) > 0) {
        console.debug('s > N/2, s = N/2 - r, old s, v', s.toString('hex'), v)
        sInt = n.subtract(sInt)
        let sHex = sInt.toHex()
        sHex = (sHex.length % 2) ? ('0' + sHex) : sHex
        s = Buffer.from(sHex, 'hex')
        v = v ? 0 : 1
        console.debug('new s, v', s.toString('hex'), v)
      }
      return {remain, v, r, s, pubKey}
    }

    let signBtc = async (coinType, tx) => {
      let makeBasicScript = (tx) => {
        return {
          version: 1,
          inputs: tx.inputs.map(input => {
            return {
              hash: input.txId,
              index: input.index,
              scriptSig: input.script,
              sequence: 0xFFFFFFFD // opt-in full-RBF, BIP 125
            }
          }),
          outputs: tx.outputs.map(output => {
            let scriptPubKey = D.address.makeOutputScript(coinType, output.address)
            return {
              amount: output.value,
              scriptPubKey: scriptPubKey
            }
          }),
          lockTime: 0
        }
      }

      let makePreSignScript = (i, basicScript) => {
        let script = D.copy(basicScript)
        script.inputs.forEach((input, j) => {
          if (i !== j) input.scriptSig = ''
        })
        let preSignScript = bitPony.tx.write(
          script.version, script.inputs, script.outputs, script.lockTime)
        return Buffer.concat([preSignScript, Buffer.from('01000000', 'hex')])
      }

      let makeScriptSig = (r, s, pubKey) => {
        // DER encode
        let scriptSigLength = 0x03 + 0x22 + 0x22 + 0x01 + 0x22
        // s must < N/2, r has no limit
        let upperR = r[0] >= 0x80
        if (upperR) scriptSigLength++

        let scriptSig = Buffer.allocUnsafe(scriptSigLength)
        let index = 0
        let sigLength = 0x22 + 0x22 + (upperR ? 0x01 : 0x00)
        scriptSig[index++] = 0x03 + sigLength
        scriptSig[index++] = 0x30
        scriptSig[index++] = sigLength
        // r
        scriptSig[index++] = 0x02
        scriptSig[index++] = upperR ? 0x21 : 0x20
        if (upperR) scriptSig[index++] = 0x00
        r.copy(scriptSig, index)
        index += r.length
        // s
        scriptSig[index++] = 0x02
        scriptSig[index++] = 0x20
        s.copy(scriptSig, index)
        index += s.length
        // hashType
        scriptSig[index++] = 0x01
        // pubKey, compressed type
        scriptSig[index++] = 0x21
        scriptSig[index++] = pubKey[63] % 2 === 0 ? 0x02 : 0x03
        pubKey = pubKey.slice(0, 32)
        pubKey.copy(scriptSig, index)

        return scriptSig
      }

      let basicScript = makeBasicScript(tx)
      let signedTx = D.copy(basicScript)
      let changePathBuffer = tx.changePath && D.address.path.toBuffer(tx.changePath)
      // execute in order
      let sequence = Promise.resolve()
      tx.inputs.forEach((input, i) => {
        sequence = sequence.then(async () => {
          let pathBuffer = D.address.path.toBuffer(input.path)
          let preSignScript = makePreSignScript(i, basicScript)
          let apduData = buildSign(pathBuffer, changePathBuffer, preSignScript)
          let response = await sendSign(apduData, true)
          let {r, s, pubKey} = await parseSignResponse(coinType, response)
          let scirptSig = makeScriptSig(r, s, pubKey)
          signedTx.inputs[i].scriptSig = scirptSig.toString('hex')
        })
      })
      await sequence

      signedTx = bitPony.tx.write(signedTx.version, signedTx.inputs, signedTx.outputs, signedTx.lockTime).toString('hex')
      return {
        id: bitPony.tx.read(signedTx).hash,
        hex: signedTx
      }
    }

    let signEth = async (coinType, tx) => {
      let chainId = D.coin.params.eth.getChainId(coinType)

      // rlp
      let unsignedTx = [tx.nonce, tx.gasPrice, tx.gasLimit, tx.output.address, tx.output.value, tx.data, chainId, 0, 0]
      let rlpUnsignedTx = rlp.encode(unsignedTx)

      let apduData = buildSign(D.address.path.toBuffer(tx.input.path), null, rlpUnsignedTx)
      let response = await sendSign(apduData)
      let {v, r, s} = await parseSignResponse(coinType, response)
      let signedTx = [tx.nonce, tx.gasPrice, tx.gasLimit, tx.output.address, tx.output.value, tx.data,
        35 + chainId * 2 + (v % 2), r, s]
      let rawTx = rlp.encode(signedTx).toString('hex')
      let txId = D.address.keccak256(rlp.encode(signedTx))
      return {
        id: txId,
        hex: rawTx
      }
    }

    let signEos = async (coinType, tx) => {
      let chainId = D.coin.params.eos.getChainId(coinType)

      let rawTx = FcBuffer.serializeTx(tx)
      console.log('signEos rawTx', rawTx.toString('hex'))
      let packedContextFreeData = Buffer.from('0000000000000000000000000000000000000000000000000000000000000000', 'hex')
      let signBuf = Buffer.concat([chainId, rawTx, packedContextFreeData])

      let signedTx = {
        compression: 'none',
        packedContextFreeData: '',
        packed_trx: rawTx.toString('hex'),
        signatures: []
      }

      while (true) {
        let response = await sendSign(signBuf)
        let {remain, v, r, s} = parseSignResponse(coinType, response)
        let i = v + 4 + 27
        let buffer = Buffer.allocUnsafe(65)
        buffer.writeUInt8(i, 0)
        r.copy(buffer, 1)
        s.copy(buffer, 33)

        let checkBuffer = Buffer.concat([buffer, Buffer.from('K1')])
        let check = createHash('ripemd160').update(checkBuffer).digest().slice(0, 4)
        let signature = base58.encode(Buffer.concat([buffer, check]))
        signedTx.signatures.push('SIG_K1_' + signature)

        if (remain === 0) break
      }

      let txId = createHash('sha256').update(rawTx).digest().toString('hex')
      return {txId, signedTx}
    }

    if (D.isBtc(coinType)) {
      return signBtc(coinType, tx)
    } else if (D.isEth(coinType)) {
      return signEth(coinType, tx)
    } else if (D.isEos(coinType)) {
      return signEos(coinType, tx)
    } else {
      console.warn('S300Wallet don\'t support this coinType', coinType)
      throw D.error.coinNotSupported
    }
  }

  /**
   * Apdu encrypt and decrypt
   */
  async sendApdu (apdu, isEnc = false, coinType = null) {
    isEnc = this._allEnc || isEnc
    // a simple lock to guarantee apdu order
    while (this._busy) {
      await D.wait(10)
    }
    this._busy = true

    try {
      if (typeof apdu === 'string') {
        apdu = Buffer.from(apdu, 'hex')
      }
      console.log('send apdu', apdu.toString('hex'))
      if (isEnc) {
        // 1. some other program may try to send command to device
        // 2. in some limit situation, device is not stable yet
        // try up to 3 times
        await this._doHandShake()
          .catch(() => this._doHandShake())
          .catch(() => this._doHandShake())

        // select applet if it's not a select APDU
        if (apdu[0] !== 0x00 && apdu[1] !== 0xA4 && apdu[2] !== 0x04) {
          await this._select(coinType)
        }
        apdu = await this._handShake.encApdu(apdu)
        console.debug('send enc apdu', apdu.toString('hex'))
      }

      let response = await this._transmit(apdu)
      if (isEnc) {
        console.debug('got enc response', response.toString('hex'))
        let decResponse = await this._handShake.decResponse(response)
        S300Wallet._checkSw1Sw2(decResponse.result)
        response = decResponse.response
      }
      console.log('got response', response.toString('hex'), 'isEnc', isEnc)
      return response
    } finally {
      this._busy = false
    }
  }

  async _doHandShake () {
    if (this._handShake.isFinished) return
    let {tempKeyPair, apdu} = await this._handShake.generateHandshakeApdu()
    console.debug('handshake apdu', apdu.toString('hex'))
    let response = await this._transmit(apdu)
    console.debug('handshake apdu response', response.toString('hex'))
    await this._handShake.parseHandShakeResponse(response, tempKeyPair, apdu)
  }

  /**
   * APDU special response handling
   */
  async _transmit (apdu) {
    let {result, response} = await this._transmitter.transmit(apdu)

    // 9060 means busy, send 00c0000000 immediately to get response
    while (result === 0x9060) {
      let waitCmd = Buffer.from('000C0000000', 'hex')
      let {_result, _response} = await this._transmitter.transmit(waitCmd)
      result = _result
      response = _response
    }

    // 61XX means there are still XX bytes to get
    while ((result & 0xFF00) === 0x6100) {
      console.debug('got 0x61XX, get remain data', result & 0xFF)
      let rApdu = Buffer.from('00C0000000', 'hex')
      rApdu[0x04] = result & 0xFF
      rApdu[0x04] = (rApdu[0x04] && rApdu[0x04]) || 0xFF
      let ret = await this._transmitter.transmit(rApdu)
      response = Buffer.concat([response, ret.response])
      result = ret.result
    }

    S300Wallet._checkSw1Sw2(result)
    return response
  }

  static _checkSw1Sw2 (sw1sw2) {
    let errorCode = D.error.checkSw1Sw2(sw1sw2)
    if (errorCode !== D.error.succeed) throw errorCode
  }
}
