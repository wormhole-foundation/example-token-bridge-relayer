"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
exports.__esModule = true;
exports.tokenBridgeTransform = exports.tokenBridgeDenormalizeAmount = exports.tokenBridgeNormalizeAmount = exports.findTransferCompletedEventInLogs = exports.formatWormholeMessageFromReceipt = exports.parseWormholeEventsFromReceipt = exports.readWormUSDContractAddress = exports.readTokenBridgeRelayerContractAddress = exports.makeWallet = void 0;
var ethers_1 = require("ethers");
var wormhole_sdk_1 = require("@certusone/wormhole-sdk");
var consts_1 = require("./consts");
var fs = require("fs");
function makeWallet(provider, pk) {
    return new ethers_1.ethers.Wallet(pk, provider);
}
exports.makeWallet = makeWallet;
function readTokenBridgeRelayerContractAddress(chain, isTest) {
    if (isTest === void 0) { isTest = false; }
    var broadcastType;
    if (isTest) {
        broadcastType = "broadcast-test";
    }
    else {
        broadcastType = "broadcast";
    }
    return JSON.parse(fs.readFileSync("".concat(__dirname, "/../../").concat(broadcastType, "/deploy_contracts.sol/").concat(chain, "/run-latest.json"), "utf-8")).transactions[2].contractAddress;
}
exports.readTokenBridgeRelayerContractAddress = readTokenBridgeRelayerContractAddress;
function readWormUSDContractAddress(chain) {
    return JSON.parse(fs.readFileSync("".concat(__dirname, "/../../broadcast-test/deploy_wormUSD.sol/").concat(chain, "/run-latest.json"), "utf-8")).transactions[0].contractAddress;
}
exports.readWormUSDContractAddress = readWormUSDContractAddress;
function parseWormholeEventsFromReceipt(receipt) {
    return __awaiter(this, void 0, void 0, function () {
        var wormholeMessageInterface, logDescriptions, _i, _a, log;
        return __generator(this, function (_b) {
            wormholeMessageInterface = new ethers_1.ethers.utils.Interface(consts_1.WORMHOLE_MESSAGE_EVENT_ABI);
            logDescriptions = [];
            for (_i = 0, _a = receipt.logs; _i < _a.length; _i++) {
                log = _a[_i];
                if (log.topics.includes(consts_1.WORMHOLE_TOPIC)) {
                    logDescriptions.push(wormholeMessageInterface.parseLog(log));
                }
            }
            return [2 /*return*/, logDescriptions];
        });
    });
}
exports.parseWormholeEventsFromReceipt = parseWormholeEventsFromReceipt;
function formatWormholeMessageFromReceipt(receipt, emitterChainId) {
    return __awaiter(this, void 0, void 0, function () {
        var messageEvents, results, _i, messageEvents_1, event_1, timestamp, emitterAddress, encodedObservation;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, parseWormholeEventsFromReceipt(receipt)];
                case 1:
                    messageEvents = _a.sent();
                    // find VAA events
                    if (messageEvents.length == 0) {
                        throw new Error("No Wormhole messages found!");
                    }
                    results = [];
                    // loop through each event and format the wormhole Observation (message body)
                    for (_i = 0, messageEvents_1 = messageEvents; _i < messageEvents_1.length; _i++) {
                        event_1 = messageEvents_1[_i];
                        timestamp = Math.floor(+new Date() / 1000);
                        emitterAddress = ethers_1.ethers.utils.hexlify("0x" + (0, wormhole_sdk_1.tryNativeToHexString)(event_1.args.sender, emitterChainId));
                        encodedObservation = ethers_1.ethers.utils.solidityPack(["uint32", "uint32", "uint16", "bytes32", "uint64", "uint8", "bytes"], [
                            timestamp,
                            event_1.args.nonce,
                            emitterChainId,
                            emitterAddress,
                            event_1.args.sequence,
                            event_1.args.consistencyLevel,
                            event_1.args.payload,
                        ]);
                        // append the observation to the results buffer array
                        results.push(Buffer.from(encodedObservation.substring(2), "hex"));
                    }
                    return [2 /*return*/, results];
            }
        });
    });
}
exports.formatWormholeMessageFromReceipt = formatWormholeMessageFromReceipt;
function findTransferCompletedEventInLogs(logs, contract) {
    var result = {};
    for (var _i = 0, logs_1 = logs; _i < logs_1.length; _i++) {
        var log = logs_1[_i];
        if (log.address == ethers_1.ethers.utils.getAddress(contract)) {
            var iface = new ethers_1.ethers.utils.Interface([
                "event TransferRedeemed(uint16 indexed emitterChainId, bytes32 indexed emitterAddress, uint64 indexed sequence)",
            ]);
            result = iface.parseLog(log).args;
            break;
        }
    }
    return result;
}
exports.findTransferCompletedEventInLogs = findTransferCompletedEventInLogs;
function tokenBridgeNormalizeAmount(amount, decimals) {
    if (decimals > 8) {
        amount = amount.div(Math.pow(10, (decimals - 8)));
    }
    return amount;
}
exports.tokenBridgeNormalizeAmount = tokenBridgeNormalizeAmount;
function tokenBridgeDenormalizeAmount(amount, decimals) {
    if (decimals > 8) {
        amount = amount.mul(Math.pow(10, (decimals - 8)));
    }
    return amount;
}
exports.tokenBridgeDenormalizeAmount = tokenBridgeDenormalizeAmount;
function tokenBridgeTransform(amount, decimals) {
    return tokenBridgeDenormalizeAmount(tokenBridgeNormalizeAmount(amount, decimals), decimals);
}
exports.tokenBridgeTransform = tokenBridgeTransform;
