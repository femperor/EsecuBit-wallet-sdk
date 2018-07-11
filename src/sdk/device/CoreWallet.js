
import D from '../D'
import ChromeHidDevice from './ChromeHidDevice'
import MockDevice from './MockDevice'
import EsTransmitter from './EsTransmitter'
import rlp from 'rlp'
import BigInteger from 'bigi'
import bitPony from 'bitpony'

let copy = D.buffer.copy
let slice = D.buffer.slice
let allEnc = true

// rewrite _containKeys to make empty value available, so we can use it to build presign tx
// noinspection JSPotentiallyInvalidConstructorUsage
bitPony.prototype._containKeys = function (keys) {
  for (let i of keys) {
    if (this.data[i] === null) {
      throw new Error('key ' + this.type + '.' + i + ' can not be null ' + this.data[i])
    }
  }
}

export default class CoreWallet {
  constructor () {
    if (CoreWallet.prototype.Instance) {
      return CoreWallet.prototype.Instance
    }
    CoreWallet.prototype.Instance = this

    this._device = D.test.mockDevice ? new MockDevice() : new ChromeHidDevice()
    this._transmitter = new EsTransmitter(this._device)
    this._walletId = 'defaultId'
  }

  async init () {
    return {walletId: this._walletId}
  }

  async sync () {
    // TODO get index from device
  }

  async updateIndex (addressInfo) {
  }

  listenPlug (callback) {
    this._device.listenPlug(callback)
  }

  async getWalletInfo () {
    let cosVersion = await this._getCosVersion()
    let firmwareVersion = await this._getFirmwareVersion()
    return [
      {name: 'COS Version', value: D.toHex(cosVersion)},
      {name: 'Firmware Version', value: D.toHex(firmwareVersion)}]
  }

  // noinspection JSMethodCanBeStatic
  _getFirmwareVersion () {
    throw D.error.notImplemented
  }

  // noinspection JSMethodCanBeStatic
  _getCosVersion () {
    throw D.error.notImplemented
  }

  async verifyPin () {
    return this._sendApdu('8082008100')
  }

  async getAddress (coinType, path, isShowing) {
    // bit 0: 0 not save on key / 1 save on key
    // bit 1: 0 not show on key / 1 show on key
    // bit 2: 0 public key / 1 address
    // if bit2 == 0, bit0 == bit1 == 0
    let flag = isShowing ? 0x07 : 0x04
    let apdu = new Uint8Array(26)
    copy('803D00001505', 0, apdu, 0)
    apdu[3] = flag
    let pathBuffer = D.address.path.toBuffer(path)
    copy(pathBuffer, 0, apdu, 6)

    let response = await this._sendApdu(apdu.buffer)
    let address = String.fromCharCode.apply(null, new Uint8Array(response))
    if (D.isBtc(coinType) && D.test.coin) {
      let addressBuffer = D.address.toBuffer(address)
      addressBuffer = D.buffer.concat('6F', addressBuffer)
      address = D.address.toString(addressBuffer)
    }
    return address
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
   * [nonce, gasprice, startgas, to, value, data, v, r, s]
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
   *   gasPrice: number,
   *   startGas: number,
   *   data: hex string,
   * }
   */
  async signTransaction (coinType, tx) {
    let sign = async (path, changePath, msg) => {
      // 803D0100 00XXXX C0 u1PathNum pu1Path C1 u1ChangePathNum pu1ChangePath C2 xxxx pu1Msg
      let dataLength =
        2 + path.byteLength +
        (changePath ? (2 + changePath.byteLength) : 2) +
        3 + msg.byteLength
      let apdu = new Uint8Array(7 + dataLength)
      copy('803D0100', 0, apdu, 0)
      let index = 4
      apdu[index++] = dataLength >> 16
      apdu[index++] = dataLength >> 8
      apdu[index++] = dataLength

      apdu[index++] = 0xC0
      apdu[index++] = path.byteLength / 4
      copy(path, 0, apdu, index)
      index += path.byteLength

      apdu[index++] = 0xC1
      apdu[index++] = changePath ? (changePath.byteLength / 4) : 0
      changePath && copy(changePath, 0, apdu, index)
      index += changePath ? changePath.byteLength : 0

      apdu[index++] = 0xC2
      apdu[index++] = msg.byteLength >> 8
      apdu[index++] = msg.byteLength
      copy(msg, 0, apdu, index)

      let response = await this._sendApdu(apdu, true)
      let r = slice(response, 0, 32)
      let s = slice(response, 32, 64)
      let pubKey = slice(response, 64, 128)
      let v = parseInt(D.toHex(slice(response, 128, 129))) % 2

      let n = new BigInteger('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141', 16)
      const N_OVER_TWO = n.shiftRight(1)
      let rInt = BigInteger.fromBuffer(Buffer.from(r))
      if (rInt.compareTo(N_OVER_TWO) > 0) {
        console.debug('r > N/2, r = r - N/2, old r, v', D.toHex(r), v)
        rInt = n.subtract(rInt)
        r = D.toBuffer(rInt.toString(16))
        v = v ? 0 : 1
        console.debug('new r, v', D.toHex(r), v)
      }
      return {v, r, s, pubKey}
    }

    // sign for P2PKH
    let signBtc = async (tx) => {
      let makeBasicScript = (tx) => {
        return {
          version: 1,
          inputs: tx.inputs.map(input => {
            return {
              hash: input.txId,
              index: input.index,
              scriptSig: input.script,
              sequence: 0xFFFFFFFF
            }
          }),
          outputs: tx.outputs.map(output => {
            return {
              amount: output.value,
              scriptPubKey: '76A914' + D.toHex(D.address.toBuffer(output.address)) + '88AC'
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
        let preSignScript = D.toBuffer(bitPony.tx.write(
          script.version, script.inputs, script.outputs, script.lockTime).toString('hex'))
        return D.buffer.concat(preSignScript, '01000000')
      }

      let makeScriptSig = (r, s, pubKey) => {
        // DER encode
        let scriptSigLength = 0x02 + 0x22 + 0x22 + 0x42 + 0x01
        // r must < N/2, s has no limit
        let sView = new Uint8Array(s)
        let upperS = sView[0] >= 0x80
        if (upperS) scriptSigLength++

        let scriptSig = new Uint8Array(scriptSigLength)
        let index = 0
        scriptSig[index++] = 0x30
        scriptSig[index++] = scriptSigLength - 0x02
        // r
        scriptSig[index++] = 0x02
        scriptSig[index++] = 0x20
        copy(r, 0, scriptSig, index)
        index += r.byteLength
        // s
        scriptSig[index++] = 0x02
        scriptSig[index++] = upperS ? 0x21 : 0x20
        if (upperS) scriptSig[index++] = 0x00
        copy(s, 0, scriptSig, index)
        index += s.byteLength
        // pubKey
        scriptSig[index++] = 0x41
        scriptSig[index++] = 0x04 // uncompress type
        copy(pubKey, 0, scriptSig, index)
        index += pubKey.byteLength
        // hashType
        scriptSig[index] = 0x01

        return scriptSig
      }

      let basicScript = makeBasicScript(tx)
      let signedTx = D.copy(basicScript)
      let changePathBuffer = D.address.path.toBuffer(tx.changePath)
      // execute in order
      let sequence = Promise.resolve()
      tx.inputs.forEach((input, i) => {
        sequence = sequence.then(async () => {
          let pathBuffer = D.address.path.toBuffer(input.path)
          let preSignScript = makePreSignScript(i, basicScript)
          let {r, s, pubKey} = await sign(pathBuffer, changePathBuffer, preSignScript)
          let scirptSig = makeScriptSig(r, s, pubKey)
          signedTx.inputs[i].scriptSig = D.toHex(scirptSig)
        })
      })
      await sequence

      signedTx = bitPony.tx.write(signedTx.version, signedTx.inputs, signedTx.outputs, signedTx.lockTime).toString('hex')
      return {
        id: bitPony.tx.read(signedTx).hash,
        hex: signedTx
      }
    }

    let signEth = async (tx) => {
      const chainIds = {}
      chainIds[D.coin.main.eth] = 1
      chainIds[D.coin.test.ethRinkeby] = 4
      let chainId = chainIds[coinType]
      if (!chainId) throw D.error.coinNotSupported

      // rlp
      let unsignedTx = [tx.nonce, tx.gasPrice, tx.startGas, tx.output.address, tx.output.value, tx.data, chainId, 0, 0]
      let rlpUnsignedTx = rlp.encode(unsignedTx)
      let rlpBuffer = D.toBuffer(rlpUnsignedTx.toString('hex'))

      let {v, r, s} = await sign(D.address.path.toBuffer(tx.input.path), null, rlpBuffer)
      let signedTx = [tx.nonce, tx.gasPrice, tx.startGas, tx.output.address, tx.output.value, tx.data,
        35 + chainId * 2 + (v % 2), Buffer.from(r), Buffer.from(s)]
      let rawTx = D.toHex(rlp.encode(signedTx)).toLowerCase()
      let txId = D.address.keccak256(rlp.encode(signedTx))
      return {
        id: txId,
        hex: rawTx
      }
    }

    await this.verifyPin()
    if (D.isBtc(coinType)) {
      return signBtc(tx)
    } else if (D.isEth(coinType)) {
      return signEth(tx)
    } else {
      throw D.error.coinNotSupported
    }
  }

  async getRandom (length) {
    if (length > 255) throw D.error.notImplemented
    let apdu = '00840000' + (length >> 8) + (length % 0xFF)
    return this._sendApdu(apdu)
  }

  _sendApdu (apdu, isEnc = false) {
    return this._transmitter.sendApdu(apdu, allEnc || isEnc)
  }
}
