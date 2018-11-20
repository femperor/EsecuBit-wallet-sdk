
import D from '../D'
import IAccount from './IAccount'
import {BigDecimal} from 'bigdecimal'

const tokenList = {
  'EOS': {
    name: 'EOS',
    account: 'eosio.token',
    precision: 4
  },
  'SYS': {
    name: 'SYS',
    account: 'eosio.token',
    precision: 4
  },
  'JUNGLE': {
    name: 'JUNGLE',
    account: 'eosio.token',
    precision: 4
  }
}

const maxIndexThreshold = 5

export default class EosAccount extends IAccount {
  constructor (info, device, coinData) {
    super(info, device, coinData)
    this._network = this._coinData.getNetwork(this.coinType)
    if (!this._network) {
      console.warn('EosAccount CoinData not support this network', this.coinType)
      throw D.error.invalidParams
    }
  }

  async sync (firstSync = false, offlineMode = false) {
    if (!offlineMode) {
      await this._checkPermissionAndGenerateNew()
    }

    if (!this.isRegistered()) {
      console.log('EosAccount not registered, check owner publickey')

      // slip-0048 recovery
      let i = 0
      for (; i < maxIndexThreshold; i++) {
        let path = D.address.path.makeSlip48Path(this.coinType, 0, this.index, i)
        let ownerInfo = this.addressInfos.find(a => a.path === path)
        if (!ownerInfo) {
          console.warn('account have no permission info in storage, most likely it is in offlineMode, exit')
          return
        }
        let accounts = await this._network.getAccountByPubKey(ownerInfo.publicKey)
        if (!accounts || accounts.length === 0) {
          console.info('EosAccount specific path not registered', ownerInfo)
        } else {
          // choose the first account if this key matches multi accounts
          // set the label as account name
          this.label = accounts[0]
          break
        }
        // slow down the request speed
        await D.wait(200)
      }
      if (i === maxIndexThreshold) {
        console.warn('this EosAccount has not been registered, exit')
        return
      }
    }

    this.tokens = this.tokens || {'EOS': {code: 'eosio.token', symbol: 'EOS'}}
    let newAccountInfo = await this._network.getAccountInfo(this.label, this.tokens)
    console.info('EosAccount getAccountInfo', newAccountInfo)
    await this._updatePermissions(newAccountInfo.permissions)
    this.tokens = D.copy(newAccountInfo.tokens)
    this.resources = D.copy(newAccountInfo.resources)
    this.balance = newAccountInfo.balance

    await this._coinData.updateAccount(this._toAccountInfo())

    let txs = await this._network.queryAddress(this.label, this.queryOffset)
    this.queryOffset = this._network.getNextActionSeq(this.label)
    txs.filter(tx => !this.txInfos.some(t => t.txId === tx.txId))
    for (let tx of txs) {
      tx.accountId = this.accountId
      tx.coinType = this.coinType
      tx.comment = ''
      await this._handleNewTx(tx)
    }
  }

  async _updatePermissions (permissions) {
    let updatedAddressInfos = []
    let needCheck = true
    while (needCheck) {
      for (let permission of Object.values(permissions)) {
        for (let pKey of permission.pKeys) {
          let relativeInfo = this.addressInfos.find(a => pKey.publicKey === a.publicKey)
          if (!relativeInfo) {
            console.warn('publicKey not found in class', pKey)
            continue
          }
          if (!relativeInfo.address ||
            !relativeInfo.registered ||
            relativeInfo.type !== permission.name ||
            relativeInfo.parent !== permission.parent ||
            relativeInfo.threshold !== permission.threshold ||
            relativeInfo.weight !== pKey.weight) {
            console.log('update permission info', relativeInfo, pKey)
            relativeInfo.address = this.label
            relativeInfo.registered = true
            relativeInfo.type = permission.name
            relativeInfo.parent = permission.parent
            relativeInfo.threshold = permission.threshold
            relativeInfo.weight = pKey.weight
            updatedAddressInfos.push(relativeInfo)
          }
        }
      }
      needCheck = (await this._checkPermissionAndGenerateNew()).length > 0
    }
    await this._coinData.updateAddressInfos(updatedAddressInfos)
  }

  async _checkPermissionAndGenerateNew () {
    // see slip-0048 recovery
    let permissionPaths = this.addressInfos.map(a => {
      return {
        registered: a.registered,
        path: a.path,
        index: a.index,
        pathIndexes: D.address.path.parseString(a.path)
      }
    })
    let maxRegPermissionIndex = permissionPaths
      .filter(path => path.registered)
      .reduce((max, path) => Math.max(max, path.pathIndexes[2]), 0x80000000 - 1)
    maxRegPermissionIndex -= 0x80000000

    let startPermissionIndex = maxRegPermissionIndex + 1
    let newAddressInfos = [] // permission info
    for (let pIndex = 0; pIndex < startPermissionIndex + maxIndexThreshold; pIndex++) {
      let subPath = D.address.path.makeSlip48Path(this.coinType, pIndex, this.index)
      // filter paths that has the same coinType, permission, accountIndex
      let filteredPermissionPaths = permissionPaths.filter(path =>
        subPath === D.address.path.makeSlip48Path(
        path.pathIndexes[1] - 0x80000000,
        path.pathIndexes[2] - 0x80000000,
        path.pathIndexes[3] - 0x80000000))

      let maxKeyIndex = filteredPermissionPaths.reduce((max, path) => Math.max(max, path.index), -1)
      let maxRegisteredKeyIndex = filteredPermissionPaths
        .filter(path => path.registered)
        .reduce((max, path) => Math.max(max, path.index), -1)

      let startKeyIndex = maxKeyIndex + 1
      let startRegKeyIndex = maxRegisteredKeyIndex + 1
      for (let j = startKeyIndex; j < startRegKeyIndex + maxIndexThreshold; j++) {
        let path = D.address.path.makeSlip48Path(this.coinType, pIndex, this.index, j)
        if (!filteredPermissionPaths.some(p => p.path === path)) {
          let publicKey = await this._device.getPublicKey(this.coinType, path)
          console.debug('generate public key with path', path, publicKey)
          // generate a permissionInfo no matter it use or not for recovery
          newAddressInfos.push({
            address: '',
            accountId: this.accountId,
            coinType: this.coinType,
            path: path,
            type: '',
            index: j,
            registered: false,
            publicKey: publicKey,
            parent: '',
            txs: [] // rfu
          })
        }
      }
    }

    await this._coinData.newAddressInfos(this._toAccountInfo(), newAddressInfos)
    this.addressInfos.push(...newAddressInfos)
    return newAddressInfos
  }

  async _handleRemovedTx (removedTxId) {
    let txInfo = this.txInfos.find(txInfo => txInfo.txId === removedTxId)
    await this._coinData.removeTx(this._toAccountInfo(), [], txInfo)
    this.txInfos = this.txInfos.filter(t => t !== txInfo)
  }

  async _handleNewTx (txInfo) {
    await this._coinData.newTx(this._toAccountInfo(), [], txInfo)
    this.txInfos.push(txInfo)
  }

  /**
   * Returns whether this EOS account is registered.
   */
  isRegistered () {
    return this.addressInfos.some(a => a.registered)
  }

  /**
   * Return all permissions or {owner, active} from device(important) if not registered
   * @returns {Promise<*>}
   */
  async getPermissions () {
    if (this.permissions) {
      let permissions = D.copy(this.permissions)
      permissions.registered = true
      return permissions
    }

    return {
      registered: false,
      'owner': {
        name: 'owner',
        parent: '',
        threshold: 1,
        keys: [{
          publicKey: await this._device.getPublicKey(this.coinType, "m/48'/4'/0'/0'/0'", true), // slip-0048
          weight: 1,
          path: "m/48'/4'/0'/0'/0'"
        }]
      },
      'active': {
        name: 'active',
        parent: 'owner',
        threshold: 1,
        keys: [{
          publicKey: await this._device.getPublicKey(this.coinType, "m/48'/4'/1'/0'/0'", true), // slip-0048
          weight: 1,
          path: "m/48'/4'/1'/0'/0'"
        }]
      }
    }
  }

  async getAddress () {
    console.warn('eos don\'t support get address')
    throw D.error.notImplemented
  }

  async rename () {
    console.warn('eos don\'t support change account name')
    throw D.error.notImplemented
  }

  /**
   * token transfer based on eosio.token API
   *
   * @param details
   * {
   *   type: string,
   *   expirationAfter: decimal string / number (optional),
   *   expiration: decimal string / number (optional), // ignore if expirationAfter exists
   *   maxNetUsageWords: decimal integer string / number (optional),
   *   maxCpuUsageMs: decimal integer string / number (optional),
   *   delaySec: decimal integer string / number (optional),
   *   refBlockNum: decimal integer string / number (optional),
   *   refBlockPrefix: decimal integer string / number (optional),
   *   comment: string (optional),
   * }
   * @returns {Promise<{}>}
   * {
   *   actions: [{...}, ...],
   *   expirationAfter: decimal string / number (optional),
   *   expiration: decimal string / number (optional), // if expirationAfter not exists and expiration exists
   *   maxNetUsageWords: number,
   *   maxCpuUsageMs: number,
   *   delaySec: number,
   *   refBlockNum: number,
   *   refBlockPrefix: number,
   *   comment: string,
   * }
   */
  async prepareTx (details) {
    if (!details.token || !details.type) {
      console.warn('no require fields', details)
      throw D.error.invalidParams
    }

    let handler = {}
    handler[D.coin.params.eos.actionTypes.transfer.type] = this.prepareTransfer
    handler[D.coin.params.eos.actionTypes.issuer.type] = this.prepareIssuer
    handler[D.coin.params.eos.actionTypes.delegate.type] = this.prepareDelegate
    handler[D.coin.params.eos.actionTypes.undelegate.type] = this.prepareDelegate
    handler[D.coin.params.eos.actionTypes.buyram.type] = this.prepareBuyRam
    handler[D.coin.params.eos.actionTypes.buyrambytes.type] = this.prepareBuyRam
    handler[D.coin.params.eos.actionTypes.sellram.type] = this.prepareBuyRam
    handler[D.coin.params.eos.actionTypes.other.type] = this.prepareOther

    let method = handler[details.type]
    if (!method) {
      console.warn('unsupported transaction type', details.type)
      throw D.error.notImplemented
    }
    return method(details)
  }

  /**
   * token transfer based on eosio.token API
   *
   * @param details, common part see prepareTx
   * {
   *   token: string,
   *   outputs: [{
   *     account: string,
   *     value: decimal string / number
   *   }],
   *   sendAll: bool (optional),
   *   account: string (optional), // token contract name
   * }
   * @returns {Promise<{}>} see prepareTx
   */
  async prepareTransfer (details) {
    if (!details.token) {
      console.warn('prepareTransfer missing parameter token')
      throw D.error.invalidParams
    }

    let token = tokenList[details.token]
    details.account = details.account || token.account
    if (!details.account || typeof details.account !== 'string' || details.account.length > 12) {
      console.warn('invalid account', details)
      throw D.error.invalidParams
    }
    let tokenPrecision = details.precision || token.precision

    if (!details.outputs) {
      details.outputs = []
    }
    if (!details.outputs[0]) {
      details.outputs[0] = {address: '', value: 0}
    }

    if (details.token.length > 7) { // eosjs format.js
      console.warn('Asset symbol is 7 characters or less', details)
      throw D.error.invalidParams
    }

    for (let output of details.outputs) {
      if (!output || !output.account || !output.value || Number(output.value) < 0) {
        console.warn('prepareTransfer invalid output', output)
        throw D.error.invalidParams
      }
      output.value = EosAccount._makeAsset(tokenPrecision, token.name, output.value)
    }

    if (details.sendAll) {
      for (let output of details.outputs) {
        // noinspection JSValidateTypes
        output.value = '0'
      }
      details.outputs[0] = this.balance
    }

    let actionType = D.coin.params.eos.actionTypes.transfer
    let prepareTx = EosAccount._prepareCommon(details)
    prepareTx.actions = details.outputs.map(output => {
      let action = this._makeBasicAction(details.account, actionType.name)
      action.data = {
        from: this.label,
        to: output.account,
        quantity: output.value,
        memo: details.comment || ''
      }
      console.log(action, 'action')
      return action
    })

    console.log('prepareTransfer', prepareTx)
    return prepareTx
  }

  async prepareIssuer (details) {
    console.warn('prepareIssuer not implemented')
    throw D.error.notImplemented
  }

  /**
   * delegate based on eosio.stake API
   *
   * @param details, common part see prepareTx
   * {
   *   delegate: bool, // deletegate or undelegate,
   *   network: decimal string, / number,
   *   cpu: decimal string / number
   *   receiver: string (optional), // delegate for myself if not exists
   *   transfer: boolean (optional) // ignore when undelegate = true
   * }
   * @returns {Promise<{}>} see prepareTx
   */
  async prepareDelegate (details) {
    let token = tokenList.EOS
    let prepareTx = EosAccount._prepareCommon(details)
    let network = EosAccount._makeAsset(token.precision, token.name, details.network || 0)
    let cpu = EosAccount._makeAsset(token.precision, token.name, details.cpu || 0)
    let receiver = details.receiver || this.label
    let transfer = details.transfer || false

    let actionType = details.delegate ? D.coin.params.eos.actionTypes.delegate : D.coin.params.eos.actionTypes.undelegate
    let action = this._makeBasicAction(actionType.account, actionType.name)
    if (details.delegate) {
      action.data = {
        from: this.label,
        receiver: receiver,
        stake_net_quantity: network + ' ' + token,
        stake_cpu_quantity: cpu + ' ' + token,
        transfer: transfer ? 0 : 1
      }
    } else {
      action.data = {
        from: this.label,
        receiver: receiver,
        unstake_net_quantity: network + ' ' + token,
        unstake_cpu_quantity: cpu + ' ' + token
      }
    }
    prepareTx.actions = [action]

    console.log('prepareDelegate', prepareTx)
    return prepareTx
  }

  /**
   * buy ram based on eosio API
   *
   * @param details, common part see prepareTx
   * {
   *   buy: bool, // buy or sell
   *   quant: decimal string, / number, // buy ram for how much EOS
   *   ramBytes: decimal string / number // buy how much ram bytes, ignore if quant exists
   *   receiver: string (optional), // buy for myself if not exists
   *   transfer: boolean (optional) // ignore when undelegate = true
   * }
   * @returns {Promise<{}>} see prepareTx
   */
  async prepareBuyRam (details) {
    let prepareTx = EosAccount._prepareCommon(details)

    let receiver = details.receiver || this.label
    if (!details.buy) {
      if (!details.ramBytes) {
        console.warn('no ram quantity provided', details)
        throw D.error.invalidParams
      }
      if (details.ramBytes <= 2) {
        // got "must purchase a positive amount" when ramBytes = 0, 1 or 2
        throw D.error.networkValueTooSmall
      }
      let actionType = D.coin.params.eos.actionTypes.sellram
      let action = this._makeBasicAction(actionType.account, actionType.name)
      action.data = {
        payer: this.label,
        bytes: details.ramBytes
      }
      prepareTx.actions = [action]
    } else {
      if (details.quant) {
        let actionType = D.coin.params.eos.actionTypes.buyram
        let action = this._makeBasicAction(actionType.account, actionType.name)
        action.data = {
          payer: this.label,
          receiver: receiver,
          quant: EosAccount._makeAsset(tokenList.EOS.precision, tokenList.EOS.name, details.quant)
        }
        prepareTx.actions = [action]
      } else if (details.ramBytes) {
        if (details.ramBytes <= 2) {
          // got "must purchase a positive amount" when ramBytes = 0, 1 or 2
          throw D.error.networkValueTooSmall
        }
        let actionType = D.coin.params.eos.actionTypes.buyrambytes
        let action = this._makeBasicAction(actionType.account, actionType.name)
        action.data = {
          payer: this.label,
          receiver: receiver,
          bytes: details.ramBytes
        }
        prepareTx.actions = [action]
      } else {
        console.warn('no ram quantity provided', details)
        throw D.error.invalidParams
      }
    }

    console.log('prepareBuyRam', prepareTx)
    return prepareTx
  }

  /**
   * vote based on eosio API
   *
   * @param details, common part see prepareTx
   * {
   *   proxy: string,
   *   producers: string array
   * }
   * @returns {Promise<{}>} see prepareTx
   */
  async prepareVote (details) {
    let producers = details.producers || []
    let proxy = details.proxy || ''

    let prepareTx = EosAccount._prepareCommon(details)
    let actionType = D.coin.params.eos.actionTypes.vote
    let action = this._makeBasicAction(actionType.account, actionType.name)
    action.data = {
      voter: this.label,
      proxy: proxy,
      producers: producers
    }
    prepareTx.actions = [action]

    console.log('prepareVote', prepareTx)
    return prepareTx
  }

  /**
   * customize transaction
   *
   * @param details, common part see prepareTx
   * {
   *   account: string, // contract name,
   *   name: string // contract name
   *   data: hex string
   * }
   * @returns {Promise<{}>} see prepareTx
   */
  async prepareOther (details) {
    console.warn('prepareDelegate not implemented')
    throw D.error.notImplemented
  }

  static _prepareCommon (details) {
    const defaultExpirationAfter = 10 * 60 // seconds

    let prepareTx = {}
    if (details.expirationAfter) {
      prepareTx.expirationAfter = Number(details.expirationAfter)
    } else if (details.expiration) {
      prepareTx.expiration = Number(details.expiration)
    } else {
      prepareTx.expirationAfter = defaultExpirationAfter
    }

    if (details.maxNetUsageWords) {
      prepareTx.maxNetUsageWords = Number(details.maxNetUsageWords)
    }
    if (details.maxCpuUsageMs) {
      prepareTx.maxCpuUsageMs = Number(details.maxCpuUsageMs)
    }
    if (details.delaySec) {
      prepareTx.delaySec = Number(details.delaySec)
    }
    if (details.refBlockNum) {
      prepareTx.refBlockNum = Number(details.refBlockNum)
    }
    if (details.refBlockPrefix) {
      prepareTx.refBlockPrefix = Number(details.refBlockPrefix)
    }
    prepareTx.comment = details.comment || ''
    return prepareTx
  }

  static _makeAsset (tokenPrecision, token, value) {
    if (typeof value !== 'string') {
      value = new BigDecimal(value).toPlainString()
    }
    let parts = value.split('.')
    let precision = (parts[1] && parts[1].length) || 0
    if (precision > 18) { // eosjs format.js
      console.warn('Precision should be 18 characters or less', tokenPrecision, value)
      throw D.error.invalidParams
    } else if (precision > tokenPrecision) {
      console.warn('precision bigger than token specific precision', tokenPrecision, precision, value)
      throw D.error.invalidParams
    } else {
      if (parts[1] === undefined) value += '.'
      value += '0'.repeat(tokenPrecision - precision)
    }
    return value + ' ' + token
  }

  _makeBasicAction (account, name) {
    // TODO later, configurable permission
    return {
      account: account,
      name: name,
      authorization: [{
        actor: this.label,
        permission: 'active'
      }]
    }
  }

  /**
   * use the result of prepareTx to make transaction
   * @param prepareTx
   * @returns {Promise<{txInfo, addressInfo, hex}>}
   * @see prepareTx
   */
  async buildTx (prepareTx) {
    if (!prepareTx.refBlockNum || !prepareTx.refBlockPrefix) {
      let blockInfo = await this._network.getIrreversibleBlockInfo()
      prepareTx.refBlockNum = prepareTx.refBlockNum || blockInfo.refBlockNum
      prepareTx.refBlockPrefix = prepareTx.refBlockPrefix || blockInfo.refBlockPrefix
    }

    let expiration = prepareTx.expirationAfter
      ? Math.floor(new Date().getTime() / 1000) + prepareTx.expirationAfter
      : prepareTx.expiration
    let presignTx = {
      expiration: expiration,
      ref_block_num: prepareTx.refBlockNum,
      ref_block_prefix: prepareTx.refBlockPrefix,
      max_net_usage_words: prepareTx.maxNetUsageWords || 0,
      max_cpu_usage_ms: prepareTx.maxNetUsageWords || 0,
      delay_sec: prepareTx.delaySec || 0,
      context_free_actions: [],
      actions: prepareTx.actions,
      transaction_extensions: []
    }

    presignTx.keyPaths = []
    for (let action of presignTx.actions) {
      for (let auth of action.authorization) {
        // not support multi-sig
        let permissions = this.addressInfos.filter(a => a.type === auth.permission)
        if (permissions.length === 0) {
          console.warn('key path of relative permission not found', action)
          throw D.error.permissionNotFound
        }
        permissions.forEach(p => {
          if (!presignTx.keyPaths.includes(p.path)) {
            presignTx.keyPaths.push(p.path)
          }
        })
      }
    }

    console.log('presign tx', presignTx)
    let {txId, signedTx} = await this._device.signTransaction(this.coinType, presignTx)
    let txInfo = {
      txId: txId,
      accountId: this.accountId,
      coinType: this.coinType,
      blockNumber: D.tx.confirmation.pending,
      time: new Date().getTime(),
      confirmations: D.tx.confirmation.waiting,
      comment: prepareTx.comment,
      actions: D.copy(prepareTx.actions)
    }

    return {signedTx, txInfo}
  }

  /**
   * broadcast transaction to btcNetwork
   * @param signedTx
   * @param test won't broadcast to ethNetwork if true
   * @see signedTx
   */
  async sendTx (signedTx, test = false) {
    // broadcast transaction to network
    console.log('sendTx', signedTx)
    if (!test) await this._coinData.sendTx(this.coinType, signedTx.signedTx)
    await this._handleNewTx(signedTx.txInfo)
  }
}
