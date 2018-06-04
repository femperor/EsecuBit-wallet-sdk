
import D from '../D'
import IndexedDB from './database/IndexedDB'
import BlockChainInfo from './network/BlockChainInfo'
import FeeBitCoinEarn from './network/fee/FeeBitCoinEarn'

// TODO CoinData only manage data, don't handle data. leave it to EsAccount and EsWallet?
export default class CoinData {
  constructor () {
    if (CoinData.prototype.Instance) {
      return CoinData.prototype.Instance
    }
    CoinData.prototype.Instance = this

    this._initialized = false
    // TODO read provider from settings
    this._networkProvider = BlockChainInfo
    this._network = {}
    this._network[D.COIN_BIT_COIN_TEST] = new this._networkProvider(D.COIN_BIT_COIN_TEST)
    this._network[D.COIN_BIT_COIN] = new this._networkProvider(D.COIN_BIT_COIN)

    this._networkFee = {}
    let bitcoinFee = new FeeBitCoinEarn()
    this._networkFee[D.COIN_BIT_COIN_TEST] = bitcoinFee
    this._networkFee[D.COIN_BIT_COIN] = bitcoinFee

    this._listeners = []
  }

  async init (info) {
    try {
      if (this._initialized) return
      this._db = new IndexedDB(info.walletId)
      let initList = []
      initList.push(this._db.init())
      initList.push(...Object.values(this._network).map(network => network.init()))
      await Promise.all(initList)
      this._initialized = true
    } catch (e) {
      console.info(e)
      throw D.ERROR_UNKNOWN
    }
  }

  async release () {
    this._listeners = []
    await Promise.all(Object.values(this._network).map(network => network.release()))
    if (this._db) await this._db.release()
  }

  async getAccounts (filter = {}) {
    return this._db.getAccounts(filter)
  }

  addListener (callback) {
    let exists = this._listeners.some(listener => listener === callback)
    if (exists) {
      console.info('addTransactionListener already has this listener', callback)
      return
    }
    this._listeners.push(callback)
  }

  removeListener (callback) {
    this._listeners = this._listeners.filter(listener => listener !== callback)
  }

  async newAccount (coinType) {
    let accountIndex = await await this._newAccountIndex(coinType)
    if (accountIndex === -1) {
      throw D.ERROR_LAST_ACCOUNT_NO_TRANSACTION
    }

    let account = await this._newAccount(coinType, accountIndex)
    if (D.TEST_DATA && accountIndex === 0 && (coinType === D.COIN_BIT_COIN || coinType.D.COIN_BIT_COIN_TEST)) {
      await this._initTestDbData(account)
    }
    await this._db.newAccount(account)
    return account
  }

  async _newAccount (coinType, accountIndex) {
    let makeId = function () {
      let text = ''
      const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
      for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length))
      }
      return text
    }

    let account = {
      accountId: makeId(),
      label: 'Account#' + (accountIndex + 1),
      coinType: coinType,
      index: accountIndex,
      balance: 0
    }
    console.info('newAccount', account)
    return account
  }

  /**
   * according to BIP32, check whether the spec coinType has account or the last spec coinType account has transaction
   * @return index of new account, -1 if unavailable
   */
  async _newAccountIndex (coinType) {
    let accounts = await this._db.getAccounts()

    // check whether the last spec coinType account has transaction
    let lastAccount = null
    let accountIndex = 0
    for (let account of accounts) {
      if (account.coinType === coinType) {
        lastAccount = account
        accountIndex++
      }
    }

    // TODO check whether lastAccount is the last account created
    if (lastAccount === null) {
      return 0
    }
    let {total} = await this._db.getTxInfos(
      {
        accountId: lastAccount.accountId,
        startIndex: 0,
        endIndex: 1
      })
    if (total === 0) {
      return -1
    }
    return accountIndex
  }

  async deleteAccount (account) {
    let {total} = await this._db.getTxInfos({accountId: account.accountId})
    if (total !== 0) {
      console.warn('attemp to delete a non-empty account', account)
      throw D.ERROR_ACCOUNT_HAS_TRANSACTIONS
    }
    console.info('delete account', account)
    await this._db.deleteAccount(account)
  }

  async saveOrUpdateTxInfo (txInfo) {
    await this._db.saveOrUpdateTxInfo(txInfo)
    this._listeners.forEach(listener => listener(D.ERROR_NO_ERROR, txInfo))
  }

  async newAddressInfos (account, addressInfos) {
    await this._db.newAddressInfos(account, addressInfos)
  }

  getAddressInfos (filter) {
    return this._db.getAddressInfos(filter)
  }

  getTxInfos (filter) {
    return this._db.getTxInfos(filter)
  }

  getUtxos (filter) {
    return this._db.getUtxos(filter)
  }

  async newTx (account, addressInfo, txInfo, utxos) {
    await this._db.newTx(account, addressInfo, txInfo, utxos)
    this._listeners.forEach(listener => listener(D.ERROR_NO_ERROR, txInfo))
  }

  checkAddresses (coinType, addressInfos) {
    return this._network[coinType].checkAddresses(addressInfos)
  }

  listenAddresses (coinType, addressInfos, callback) {
    console.info('listen addresses', addressInfos)
    return this._network[coinType].listenAddresses(addressInfos, callback)
  }

  listenTx (coinType, txInfo, callback) {
    console.info('listen txInfo', txInfo)
    return this._network[coinType].listenTx(txInfo, callback)
  }

  removeNetworkListener (coinType, callback) {
    return this._network[coinType].removeListener(callback)
  }

  async sendTx (account, utxos, txInfo, rawTx) {
    await this._network[account.coinType].sendTx(rawTx)
  }

  async getSuggestedFee (coinType) {
    switch (coinType) {
      case D.COIN_BIT_COIN:
      case D.COIN_BIT_COIN_TEST:
        return this._networkFee[coinType].updateFee()
      default:
        throw D.ERROR_COIN_NOT_SUPPORTED
    }
  }

  /*
   * Test data when TEST_DATA = true
   */
  async _initTestDbData (account) {
    console.info('TEST_DATA add test txInfo')
    account.balance = 32000000
    let accountId = account.accountId
    // TODO update data
    await Promise.all([
      this._db.saveOrUpdateTxInfo(
        {
          accountId: accountId,
          coinType: D.COIN_BIT_COIN,
          txId: '574e073f66897c203a172e7bf65df39e99b11eec4a2b722312d6175a1f8d00c3',
          address: '1Lhyvw28ERxYJRjAYgntWazfmZmyfFkgqw',
          direction: D.TX_DIRECTION_IN,
          time: 1524138384000,
          outIndex: 0,
          script: '76a91499bc78ba577a95a11f1a344d4d2ae55f2f857b9888ac',
          value: 84000000,
          hasDetails: false
        }),

      this._db.saveOrUpdateTxInfo(
        {
          accountId: accountId,
          coinType: D.COIN_BIT_COIN,
          txId: '574e073f66897c203a172e7bf65df39e99b11eec4a2b722312d6175a1f8d00c4',
          address: '3PfcrxHzT6WuNo7tcqmAdLKn6EvgXCCSiQ',
          direction: D.TX_DIRECTION_OUT,
          time: 1524138384000,
          value: 18000000,
          hasDetails: false
        }),

      this._db.saveOrUpdateTxInfo(
        {
          accountId: accountId,
          coinType: D.COIN_BIT_COIN,
          txId: '574e073f66897c203a172e7bf65df39e99b11eec4a2b722312d6175a1f8d00c5',
          address: '14F7iCA4FsPEYj67Jpme2puVmwAT6VoVEU',
          direction: D.TX_DIRECTION_OUT,
          time: 1524138384000,
          value: 34000000,
          hasDetails: false
        }),

      this._db.saveOrUpdateAddressInfo(
        {
          address: '14F7iCA4FsPEYj67Jpme2puVmwAT6VoVEU',
          accountId: accountId,
          coinType: D.COIN_BIT_COIN,
          path: [0x80000000, 0x8000002C, 0x80000000, 0x00000000, 0x00000000],
          type: D.ADDRESS_EXTERNAL,
          txIds: []
        })
    ])
  }
}
