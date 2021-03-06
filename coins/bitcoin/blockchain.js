/**
* MIT License
*
* Copyright (c) 2020 Code Particle Inc.
*
* Permission is hereby granted, free of charge, to any person obtaining a copy
* of this software and associated documentation files (the "Software"), to deal
* in the Software without restriction, including without limitation the rights
* to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
* copies of the Software, and to permit persons to whom the Software is
* furnished to do so, subject to the following conditions:
*
* The above copyright notice and this permission notice shall be included in all
* copies or substantial portions of the Software.
*
* THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
* IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
* FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
* AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
* LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
* OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
* SOFTWARE.
*/
import * as bitcoin from 'bitcoinjs-lib';
import * as bip39 from 'bip39';
import * as bip32 from 'bip32';

import { ERRORS } from 'lib/constants';
import { asErrorObject, getTimestamp, satoshiToFloat } from 'lib/utils';
import { api } from 'rdx/api';

import { ApiBlockchainManager } from 'api/api-blockchain-manager';
import { getInputs, getOutputs, getSatoshisToSend } from 'coins/bitcoin/utils';
import {
  BIP32,
  DEFAULT_FEE,
  DUST_THRESHOLD,
  EXPLORER_URLS,
  NETWORK,
  urls,
} from 'coins/bitcoin/constants';

const {
  BLOCKCHAIN: {
    API_ERROR,
    INSUFFICIENT_FUNDS,
    BROADCAST_ERROR,
  },
} = ERRORS;
const { FULL_ADDRESS } = urls;
const {
  SEND_TX,
  UNSPENT_OUTPUTS,
  VIEW_TX,
} = EXPLORER_URLS;

class BitcoinBlockchainManager extends ApiBlockchainManager {
  constructor() {
    super();
    this.defaultFee = DEFAULT_FEE;
  }

  // This class instance is always fetched using "BitcoinBlockchainManager.instance"
  static get instance() {
    if (!this._instance) {
      this._instance = new BitcoinBlockchainManager();
    }
    return this._instance;
  }
  // Used to reset a "BitcoinBlockchainManager.instance"
  static resetInstance() {
    this._instance = null;
  }

  /**
   * Base method that returns a single address from seed
   * @returns {Object} - address and privateKey
   * @param {string} mnemonicSeed - string seed from wallet
   */
  generateAddressFromSeed(mnemonicSeed, account = 0, changeChain = BIP32.CHANGE_CHAIN.EXTERNAL, numberOfAddresses = 0) {
    const addressIncrement = numberOfAddresses + 1;
    const seed = bip39.mnemonicToSeedSync(mnemonicSeed);
    const node = bip32.fromSeed(seed);
    const derived = node.derivePath(`${BIP32.DERIVATION_PATH_BASE}/${account}'/${changeChain}/${addressIncrement}`);
    const { publicKey, privateKey } = derived;
    const { address } = bitcoin.payments.p2pkh({ pubkey: publicKey, network: bitcoin.networks[NETWORK] });

    return {
      address,
      index: addressIncrement,
      privateKey: privateKey.toString('hex'),
    };
  }

  /**
   * This method creates a new address and transfers the balance left from the old address to the new one.
   * @param {object} addressParam is required.
   * @param {object} wallet is required.
   * @return {obj} returns an Address.
   */
  async refreshAddress(wallet, addressParam) {
    const { balance } = await this.fetchAddressDetails(addressParam.address);
    const { address, private_key: privateKey } = addressParam;
    const { address_index: index } = wallet;

    if (balance > 0 && balance <= DEFAULT_FEE) {
      return {
        address,
        privateKey,
        index,
      };
    }

    const newAddressData = this.generateAddressFromSeed(wallet.seed, BIP32.ACCOUNT_BASE, BIP32.CHANGE_CHAIN.EXTERNAL, index);

    if (balance !== 0) {
      await this.sendFromOneAddress({
        fromAddress: addressParam.address,
        privateKey,
        paymentData: [{
          address: newAddressData.address,
          amount: satoshiToFloat(balance - DEFAULT_FEE),
        }],
      });
    }

    return {
      address: newAddressData.address,
      index: newAddressData.index,
      privateKey: newAddressData.privateKey,
    };
  };

  /**
   * method to fetch address details from api
   * @returns {Object} address balance and transactions
   * @param {String} address - the public address string
   */
  async fetchAddressDetails(address) {
    const addrUrl = FULL_ADDRESS(address);
    const res = await api.get(addrUrl);
    const {
      balance,
      txs,
    } = res.data;

    const transactions = this.formatTransactionResponse(txs, address);

    return {
      balance,
      transactions,
    };
  }

  /**
   * Function that formats transactions from api for db insert/update
   * @returns {Array} formattedTransactions
   * @param {Array} transactions - transactions array returned by blockCypher address api
   * @param {String} address - host address
   */
  formatTransactionResponse(transactions, address) {
    const formattedTransactions = [];

    transactions.forEach(transaction => {
      let status = 0;
      let amount = 0;
      let receiver_address = null;

      const {
        confirmations = null,
        fees,
        hash,
        inputs,
        outputs,
        received,
      } = transaction;

      const sender_address = inputs[0].addresses[0];

      if (confirmations) {
        status = 1;
      }

      outputs.forEach(output => {
        if (output.addresses.includes(address)) {
          amount += output.value;
          receiver_address = address;
        }
      });

      formattedTransactions.push({
        amount: satoshiToFloat(amount),
        created_date: getTimestamp(received),
        fee: fees,
        receiver_address,
        sender_address,
        status,
        transaction_id: hash,
      });
    });

    return formattedTransactions;
  }

  async sendFromOneAddress({ fromAddress, privateKey, paymentData, fee = this.defaultFee }) {
    const keyPair = bitcoin.ECPair.fromPrivateKey(Buffer.from(privateKey, 'hex'), {
      network: bitcoin.networks[NETWORK],
    });
    // Initialize new transaction
    const tx = new bitcoin.TransactionBuilder(keyPair.network);

    // Build output array from paymentdata
    const outputs = getOutputs(paymentData);
    const satoshisToSend = getSatoshisToSend(outputs, fee);
    let unspentOutputs;

    // Fetch unspentOutputs from api, or fail early
    try {
      unspentOutputs = (await api.get(UNSPENT_OUTPUTS(fromAddress))).data;
    } catch (err) {
      return asErrorObject(API_ERROR);
    }

    // Build inputs from unspentOutputs and desired amount to send
    const { inputs, remainingSatoshis } = getInputs(unspentOutputs, satoshisToSend);

    // Fail early if insufficient balance, should be redundant via client-side check
    if (remainingSatoshis < 0) {
      return asErrorObject(INSUFFICIENT_FUNDS);
    }

    // Send change to fromAddress if remaining satoshis is greater than dust threshold
    if (remainingSatoshis && remainingSatoshis > DUST_THRESHOLD) {
      outputs.push({
        address: fromAddress,
        satoshis: remainingSatoshis,
      });
    }

    // Add each input to the transaction
    // txid = transaction hash, vout = output index
    inputs.forEach(input => {
      tx.addInput(input.txid, input.vout);
    });

    // Add each output to the transaction
    outputs.forEach(output => {
      tx.addOutput(output.address, output.satoshis);
    });

    // Sign each input
    for (let i = 0; i < inputs.length; i++) {
      tx.sign(i, keyPair);
    }

    const signedTx = tx.build().toHex();
    let res;

    try {
      res = await api.post(SEND_TX(), { rawtx: signedTx });
    } catch (err) {
      return asErrorObject(API_ERROR);
    }

    const { status, data: { txid } } = res;

    if (status === 200) {
      return {
        error: false,
        link: VIEW_TX(txid),
      };
    }

    return asErrorObject(BROADCAST_ERROR);
  }
}

export { BitcoinBlockchainManager };
