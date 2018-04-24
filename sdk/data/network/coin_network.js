
var D = require('../../def');

var TYPE_ADDRESS = 'address';
var TYPE_TRANSACTION_INFO = 'transaction_info';

var ADDRESS_REQUEST_PERIOD = 5;
var TRANSACTION_REQUEST_PERIOD = 30;

var CoinNetwork = function() {
    this.coinType = 'undefined';
    this._requestRate = 1; // requests per second
    this._requestList = [];

    var that = this;
    this._queue = function() {
        var timeStamp = new Date().getTime();
        for (var index in that._requestList) {
            if (!that._requestList.hasOwnProperty(index)) {
                continue;
            }
            var request = that._requestList[index];
            console.warn('compare', request.nextTime, timeStamp);
            if (request.nextTime <= timeStamp) {
                request.request();
                break;
            }
        }
        setTimeout(that._queue, 1 / that._requestRate * 1000);
    };
    // not using setInterval because _requestRate is changable
    setTimeout(this._queue, 1 / this._requestRate * 1000);
};
module.exports = CoinNetwork;

CoinNetwork.prototype.provider = 'undefined';
CoinNetwork.prototype.website = 'undefined';


CoinNetwork.prototype.getFloatFee = function (fee) {
    switch (this.coinType) {
        case D.COIN_BIT_COIN:
            return Number(fee / 100000000);
        default:
            return -1;
    }
};

CoinNetwork.prototype.get = function (url, errorCallback, callback) {
    var xmlhttp = new XMLHttpRequest();
    xmlhttp.onreadystatechange = function() {
        if (xmlhttp.readyState === 4) {
            if (xmlhttp.status === 200) {
                try {
                    var coinInfo = JSON.parse(xmlhttp.responseText);
                    callback(coinInfo);
                } catch (e) {
                    console.warn(e);
                    errorCallback(D.ERROR_NETWORK_PROVIDER_ERROR);
                }
            } else if (xmlhttp.status === 500) {
                console.warn(url, xmlhttp.status);
                errorCallback(D.ERROR_NETWORK_PROVIDER_ERROR);
            } else {
                console.warn(url, xmlhttp.status);
                errorCallback(D.ERROR_NETWORK_UNVAILABLE);
            }
        }
    };
    xmlhttp.open('GET', url, true);
    xmlhttp.setRequestHeader('Content-type', 'application/x-www-form-urlencoded');
    xmlhttp.send();
};

CoinNetwork.prototype.listenTransactionInfoStatus = function (callback) {
    callback(D.ERROR_NOT_IMPLEMENTED);
};

CoinNetwork.prototype.registerListenedTransactionId = function (transactionId, callback) {
    var that = this;
    this._requestList.push({
        type: TYPE_TRANSACTION_INFO,
        txId: transactionId,
        nextTime: new Date().getTime(),
        request: function() {
            var thatRequest = this;
            that.queryTransaction(transactionId, function(error, response) {
                if (error !== D.ERROR_NO_ERROR) {
                    callback(error);
                    return;
                }
                callback(error, response);
            });
            thatRequest.nextTime += new Date().getTime() + TRANSACTION_REQUEST_PERIOD;
        }
    });
};

CoinNetwork.prototype.registerListenedAddress = function (address, listenedTxId, callback) {
    var that = this;
    this._requestList.push({
        type: TYPE_ADDRESS,
        address: address,
        listenedTxId: listenedTxId,
        nextTime: new Date().getTime(),
        request: function() {
            var thatRequest = this;
            that.queryAddress(address, function(error, response) {
                if (error !== D.ERROR_NO_ERROR) {
                    callback(error);
                    return;
                }
                var totalTxs = response.txs.slice();
                response.txs = [];
                for (var index in totalTxs) {
                    if (!totalTxs.hasOwnProperty(index)) {
                        continue;
                    }
                    if (!isInArray(thatRequest.listenedTxId, totalTxs[index].txId)) {
                        listenedTxId.push(totalTxs[index]);
                        response.txs.push(totalTxs[index]);
                    }
                }
                if (response.txs.length !== 0) {
                    callback(error, response);
                }
                thatRequest.nextTime += new Date().getTime() + ADDRESS_REQUEST_PERIOD;
            });
            function isInArray(arr,value){
                for(var i = 0; i < arr.length; i++){
                    if(value === arr[i]){
                        return true;
                    }
                }
                return false;
            }
        }
    });
};

CoinNetwork.prototype.initNetwork = function (coinType, callback) {
    callback(D.ERROR_NOT_IMPLEMENTED);
};

CoinNetwork.prototype.queryAddress = function (address, callback) {
    callback(D.ERROR_NOT_IMPLEMENTED);
};

CoinNetwork.prototype.queryTransaction = function (txId, callback) {
    callback(D.ERROR_NOT_IMPLEMENTED);
};

CoinNetwork.prototype.getSuggestedFee = function (feeType, callback) {
    callback(D.ERROR_NOT_IMPLEMENTED);
};

CoinNetwork.prototype.sendTrnasaction = function (fee) {
    callback(D.ERROR_NOT_IMPLEMENTED);
};
