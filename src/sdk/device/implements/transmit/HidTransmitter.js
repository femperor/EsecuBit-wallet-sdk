
import D from '../../../D'
import MockDevice from './io/MockDevice'
import {Buffer} from 'buffer'
import ChromeHidDevice from './io/ChromeHidDevice'
import HandShake from './HandShake'

/**
 * Esecubit USB HID protocol
 */
export default class HidTransmitter {
  constructor () {
    this._device = D.test.mockDevice ? new MockDevice() : new ChromeHidDevice()
    this._handShake = new HandShake()
    this._plugListener = () => {}
    this._device.listenPlug((error, status) => {
      if (status === D.status.plugOut) {
        this._handShake = new HandShake()
      }
      D.dispatch(() => this._plugListener(error, status))
    })
  }

  listenPlug (callback) {
    if (callback) this._plugListener = callback
  }

  /**
   * APDU encrypt & decrypt
   */
  async sendApdu (apdu, isEnc = false) {
    // a simple lock to guarantee apdu order
    while (this.busy) {
      await D.wait(10)
    }
    this.busy = true

    try {
      if (typeof apdu === 'string') {
        apdu = Buffer.from(apdu, 'hex')
      }
      console.log('send apdu', apdu.toString('hex'), 'isEnc', isEnc)
      if (isEnc) {
        // 1. some other program may try to send command to device
        // 2. in some limit situation, device is not stable yet
        // try up to 3 times
        await this._doHandShake()
          .catch(() => this._doHandShake())
          .catch(() => this._doHandShake())
        apdu = this._handShake.encApdu(apdu)
        console.debug('send enc apdu', apdu.toString('hex'))
      }
      let response = await this._sendApdu(apdu)
      if (isEnc) {
        console.debug('got enc response', response.toString('hex'), 'isEnc', isEnc)
        response = this._handShake.decResponse(response)
      }
      console.log('got response', response.toString('hex'), 'isEnc', isEnc)
      return response
    } finally {
      this.busy = false
    }
  }

  async _doHandShake () {
    let {apdu, tempKeyPair} = this._handShake.generateHandshakeApdu()
    let response = await this._sendApdu(apdu)
    this._handShake.parseHandShakeResponse(response, apdu, tempKeyPair)
  }

  /**
   * APDU special response handling
   */
  async _sendApdu (apdu) {
    let {result, response} = await this._transmit(apdu)

    // 6AA6 means busy, send 00A6000008 immediately to get response
    while (result === 0x6AA6) {
      console.debug('got 0xE0616AA6, resend apdu')
      let {_result, _response} = await this._transmit(Buffer.from('00A6000008'), 'hex')
      result = _result
      response = _response
    }

    // 61XX means there are still XX bytes to get
    while ((result & 0xFF00) === 0x6100) {
      console.debug('got 0x61XX, get remain data')
      let rApdu = Buffer.from('00C0000000', 'hex')
      rApdu[0x04] = result & 0xFF
      let ret = await this._transmit(rApdu)
      response = Buffer.concat([response, ret.response])
      result = ret.result
    }
    HidTransmitter._checkSw1Sw2(result)

    return response
  }

  /**
   * HID command pack & unpack
   */
  async _transmit (apdu) {
    if (typeof apdu === 'string') {
      apdu = Buffer.from(apdu, 'hex')
    }
    // HID command format: u1PaddingNum 04 pu1Send[u4SendLen] Padding
    let packHidCmd = (apdu) => {
      // additional length of {u1PaddingNum 04}
      let reportId = 0x00
      let reportSize = apdu.length + 0x03
      if (reportSize <= 0x110) {
        if ((reportSize & 0x07) !== 0x00) {
          reportSize &= (~0x07)
          reportSize += 0x08
        }
        reportId = reportSize >> 0x03
      } else if (reportSize <= 0x210) {
        reportSize -= 0x110
        if ((reportSize & 0x3F) !== 0x00) {
          reportSize &= ~0x3F
          reportSize += 0x40
        }
        reportId = 0x22 + (reportSize >> 0x06)
        reportSize += 0x110
      } else if (reportSize <= 0x410) {
        reportSize -= 0x210
        if ((reportSize & 0x7F) !== 0x00) {
          reportSize &= ~0x7F
          reportSize += 0x80
        }
        reportId = 0x26 + (reportSize >> 0x07)
        reportSize += 0x210
      } else {
        reportSize -= 0x410
        if ((reportSize & 0xFF) !== 0x00) {
          reportSize &= ~0xFF
          reportSize += 0x100
        }
        reportId = 0x2A + (reportSize >> 0x08)
        reportSize += 0x410
      }

      let padNum = reportSize - apdu.length - 0x03
      // don't set feature id in hid command, chrome.hid will add it automatically to the head
      let pack = Buffer.alloc(reportSize - 0x01)
      pack[0x00] = padNum
      pack[0x01] = 0x04 // opCode
      apdu.copy(pack, 0x02)
      return {reportId, pack}
    }

    // HID response format: u1ReportId u1PaddingNum 04 RESPONSE SW1 SW2 Padding[PaddingNum]
    let unpackHidCmd = (response) => {
      if (response[0x02] !== 0x04) {
        console.warn('opCode != 0x04 not supported', response.toString('hex'))
        throw D.error.deviceComm
      }

      let throwLengthError = () => {
        console.warn('unpackHidCmd hid response length incorrect', response)
        throw D.error.deviceComm
      }

      // get report size from report id
      let reportSize
      if (response[0x00] <= 0x22) {
        reportSize = response[0x00] * 0x08
        if (response[0x01] > 0x07) throw throwLengthError()
      } else if (response[0x00] <= 0x26) {
        reportSize = 0x110 + (response[0x00] - 0x22) * 0x40
        if (response[0x01] > 0x3F) throw throwLengthError()
      } else if (response[0x00] <= 0x2A) {
        reportSize = 0x210 + (response[0x00] - 0x26) * 0x80
        if (response[0x01] > 0x7F) throw throwLengthError()
      } else {
        reportSize = 0x410 + (response[0x00] - 0x2A) * 0x100
      }

      if (reportSize < (response[0x01] + 0x03)) throw throwLengthError()
      reportSize -= (response[0x01] + 0x03)
      if (reportSize < 0x02) throwLengthError()
      reportSize -= 0x02

      let result = (response[0x03 + reportSize] << 8) + response[0x04 + reportSize]
      response = response.slice(3, 3 + reportSize)
      return {result, response}
    }

    let sendAndReceive = async (reportId, pack) => {
      await this._device.send(reportId, pack)
      while (true) {
        let received = await this._device.receive()
        if (received[0x00] !== 0x00 && received[0x02] === 0x00) {
          if (received[0x07] === 0x60) {
            if (received[0x05] === 0x02) {
              // 01 00 00 00 00 02 xx 60: delay xx seconds before get response again
              let delayMills = received[0x06] * 1000 + 100 // additional 100ms
              console.debug(`device busy 02, delay ${delayMills} and resend`)
              await D.wait(delayMills)
              continue
            } else if (received[0x05] === 0x03) {
              // 01 00 00 00 00 03 xx 60: delay xx * 5 millseconds before get response again
              let delayMills = received[0x06] * 5
              console.debug(`device busy 03, delay ${delayMills} and resend`)
              await D.wait(delayMills)
              continue
            }
          } else if (received[0x07] === 0x00) {
            // 01 00 00 00 00 00 xx 00: showing control
            // key will disconnect after long time idle, in this case device will return 0x86 and then return 0x6ff2
            if (received[0x06] !== 0x86) {
              throw D.error.needPressKey
            }
          }
        }
        return received
      }
    }

    console.debug('transmit send apdu', apdu.toString('hex'))
    let {reportId, pack} = packHidCmd(apdu)
    let received = await sendAndReceive(reportId, pack)
    let response = unpackHidCmd(received)
    console.debug('transmit got response', response.result.toString(16), response.response.toString('hex'))
    return response
  }

  static _checkSw1Sw2 (sw1sw2) {
    let errorCode = D.error.checkSw1Sw2(sw1sw2)
    if (errorCode !== D.error.succeed) throw errorCode
  }
}
