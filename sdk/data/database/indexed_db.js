
import * as D from '../../def.js'
import Account from '../../account.js'

let IndexedDB = function() {
    this._db = null;

    let _thisRef = this;

    if (!('indexedDB' in window)) {
        console.warn('no indexedDB implementation');
        return;
    }

    let openRequest = indexedDB.open('wallet', 1);
    openRequest.onupgradeneeded = function(e) {
        console.log('indexedDB upgrading...');

        let db = e.target.result;

        if(!db.objectStoreNames.contains('account')) {
            let account = db.createObjectStore('account', {autoIncrement: true});
            account.createIndex('deviceID, passPhraseID', ['deviceID', 'passPhraseID'], {unique: false});
            account.createIndex('coinType', 'coinType', {unique: false});
        }

        if(!db.objectStoreNames.contains('transactionInfo')) {
            let transactionInfo = db.createObjectStore('transactionInfo', {autoIncrement: true});
            transactionInfo.createIndex('accountID', 'accountID', {unique: false});
            transactionInfo.createIndex('firstConfirmedTime', 'firstConfirmedTime', {unique: false});
        }
    };

    openRequest.onsuccess = function(e) {
        console.log('indexedDB open success!');
        _thisRef._db = e.target.result;
    };

    openRequest.onerror = function(e) {
        console.log('indexedDB open error');
        console.dir(e);
    };
};
export default IndexedDB;

IndexedDB.prototype.saveAccount = function(account, callback) {
    if (this._db === null) {
        callback(D.ERROR_OPEN_DATABASE_FAILED);
        return;
    }
    let request = this._db.transaction(['account'], 'readwrite')
        .objectStore('account')
        .add(account);

    request.onsuccess = function(e) { callback(D.ERROR_NO_ERROR, account); };
    request.onerror = function(e) { callback(D.ERROR_EXEC_DATABASE_FAILED, account); };
};

IndexedDB.prototype.loadAccounts = function(deviceID, passPhraseID, callback) {
    if (this._db === null) {
        callback(D.ERROR_OPEN_DATABASE_FAILED);
        return;
    }

    let request = this._db.transaction(['account'], 'readonly')
        .objectStore('account')
        .index('deviceID, passPhraseID')
        .getAll([deviceID, passPhraseID]);

    request.onsuccess = function(e) {
        callback(D.ERROR_NO_ERROR, e.target.result);
    };
    request.onerror = function(e) { callback(D.ERROR_EXEC_DATABASE_FAILED); };
};

IndexedDB.prototype.clearAccounts = function(deviceID, passPhraseID, callback) {
    if (this._db === null) {
        callback(D.ERROR_OPEN_DATABASE_FAILED);
        return;
    }

    let request = this._db.transaction(['account'], 'readonly')
        .objectStore('account')
        .index('deviceID, passPhraseID')
        .delete(deviceID, passPhraseID);

    request.onsuccess = function(e) {
        callback(D.ERROR_NO_ERROR);
    };
    request.onerror = function(e) { callback(D.ERROR_EXEC_DATABASE_FAILED); };
};

IndexedDB.prototype.saveTransactionInfo = function(transactionInfo) {
    if (this._db === null) {
        callback(D.ERROR_OPEN_DATABASE_FAILED);
        return;
    }

    let request = this._db.transaction(['transactionInfo'], 'readwrite')
        .objectStore('transactionInfo')
        .add(transactionInfo);

    request.onsuccess = function(e) { callback(D.ERROR_NO_ERROR, transactionInfo); };
    request.onerror = function(e) { callback(D.ERROR_EXEC_DATABASE_FAILED, transactionInfo); };
};

IndexedDB.prototype.getTransactionInfo = function(accountID, startIndex, endIndex, callback) {
    if (this._db === null) {
        callback(D.ERROR_OPEN_DATABASE_FAILED);
        return;
    }

    let range = IDBKeyRange.bound(startIndex, endIndex);
    let request = this._db.transaction(['transactionInfo'], 'readonly')
        .objectStore('transactionInfo')
        .index('accountID')
        .openCursor(range);

    request.onsuccess = function(e) {
        let cursor = e.target.result;
        let array = [];
        if(cursor) {
            array.add(cursor.value);
            console.log(cursor.key + ':');
            for(let field in cursor.value) {
                // TODO missing has own property check?
                console.log(cursor.value[field]);
            }
            cursor.continue();
        }
        callback(D.ERROR_NO_ERROR, array);
    };
    request.onerror = function(e) { callback(D.ERROR_EXEC_DATABASE_FAILED); };
};
