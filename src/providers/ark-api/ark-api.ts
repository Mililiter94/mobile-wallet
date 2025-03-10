import { Injectable, NgZone } from '@angular/core';
import {HttpClient, HttpParams} from '@angular/common/http';

import { Observable } from 'rxjs/Observable';
import { Subject } from 'rxjs/Subject';
import 'rxjs/add/operator/expand';

import { UserDataProvider } from '@providers/user-data/user-data';
import { StorageProvider } from '@providers/storage/storage';
import { ToastProvider } from '@providers/toast/toast';
import { HttpUtils } from '@root/src/utils/http-utils';

import {Transaction, TranslatableObject, BlocksEpochResponse, Wallet} from '@models/model';

import * as arkts from 'ark-ts';
import lodash from 'lodash';
import moment from 'moment';
import * as constants from '@app/app.constants';
import arktsConfig from 'ark-ts/config';
import { ArkUtility } from '../../utils/ark-utility';
import {AccountResponse, Delegate} from 'ark-ts';
import { StoredNetwork, FeeStatistic } from '@models/stored-network';
import ArkClient from '../../utils/ark-client';

interface NodeFees {
  type: number;
  min: number;
  max: number;
  avg: number;
}

interface NodeFeesResponse {
  data: NodeFees[];
}

interface NodeConfigurationConstants {
  vendorFieldLength?: number;
  activeDelegates?: number;
  epoch?: Date;
}

interface NodeConfigurationResponse {
  data: {
    feeStatistics: FeeStatistic[],
    constants: NodeConfigurationConstants
  };
}

@Injectable()
export class ArkApiProvider {

  public onUpdatePeer$: Subject<arkts.Peer> = new Subject<arkts.Peer>();
  public onUpdateDelegates$: Subject<arkts.Delegate[]> = new Subject<arkts.Delegate[]>();
  public onSendTransaction$: Subject<arkts.Transaction> = new Subject<arkts.Transaction>();
  public onUpdateTopWallets$: Subject<Wallet[]> = new Subject<Wallet[]>();

  private _network: StoredNetwork;
  private _api: arkts.Client;
  private _client: ArkClient;

  private _fees: arkts.Fees;
  private _delegates: arkts.Delegate[];

  public arkjs = require('arkjs');

  constructor(
    private httpClient: HttpClient,
    private zone: NgZone,
    private userDataProvider: UserDataProvider,
    private storageProvider: StorageProvider,
    private toastProvider: ToastProvider) {
    this.loadData();

    this.userDataProvider.onActivateNetwork$.subscribe((network) => {

      if (lodash.isEmpty(network)) { return; }

      this.setNetwork(network);
    });
  }

  public get network() {
    return this._network;
  }

  public get client() {
    return this._client;
  }

  public get transactionBuilder() {
    return this._api.transaction;
  }

  public get feeStatistics () {
    if (!lodash.isUndefined(this._network.feeStatistics)) { return Observable.of(this._network.feeStatistics); }

    return this.fetchFeeStatistics();
  }

  public get fees() {
    if (!lodash.isUndefined(this._fees)) { return Observable.of(this._fees); }

    return this.fetchFees();
  }

  public get delegates(): Observable<arkts.Delegate[]> {
    if (!lodash.isEmpty(this._delegates)) { return Observable.of(this._delegates); }

    return this.fetchDelegates(this._network.activeDelegates * 2);
  }

  public get topWallets(): Observable<Wallet[]> {
    return this.fetchTopWallets(constants.TOP_WALLETS_TO_FETCH);
  }

  public setNetwork(network: StoredNetwork) {
    // set default peer
    if (network.type !== null) {
      const activePeer = network.activePeer;
      const apiNetwork = arkts.Network.getDefault(network.type);
      if (apiNetwork) {
        network = Object.assign<StoredNetwork, arkts.Network>(network, apiNetwork);
      }
      if (activePeer) {
        network.activePeer = activePeer;
      }
    }
    this._delegates = [];

    this._network = network;
    this.arkjs.crypto.setNetworkVersion(this._network.version);

    this._api = new arkts.Client(this._network);
    this._client = new ArkClient(this.network.getPeerAPIUrl(), this.httpClient);
    this.findGoodPeer();

    // Fallback if the fetchEpoch fail
    this._network.epoch = arktsConfig.blockchain.date;
    // Fallback if the fetchNodeConfiguration fail
    this._network.activeDelegates = constants.NUM_ACTIVE_DELEGATES;
    this.userDataProvider.onUpdateNetwork$.next(this._network);

    this.fetchFees().subscribe();
  }

  public async findGoodPeer() {
    // Get list from active peer
    this.client.getPeerList().subscribe(async (response) => {
      if (response && await this.findGoodPeerFromList(response.peers)) {
        return;
      } else {
        await this.tryGetFallbackPeer();
      }
    },
    async () => await this.tryGetFallbackPeer());
  }

  public async findGoodSeedPeer() {
    const configNetwork = arktsConfig.networks[this._network.name];
    let peers;
    if (configNetwork) {
      peers = configNetwork.peers.map(peer => {
        const ip = peer.match(/^(\d+\.?){4}/);
        const port = peer.match(/:\d+$/);

        return {
          ip: ip[0],
          port: port[0].substring(1),
          version: configNetwork.p2pVersion
        };
      });
    } else {
      peers = this.network.peerList;
    }

    if (lodash.isEmpty(peers)) {
      return false;
    }

    await this.findGoodPeerFromList(peers);

    return true;
  }

  private async tryGetFallbackPeer() {
    if (await this.findGoodPeerFromList(this.network.peerList)) {
      return;
    }

    // Custom network
    if (!this.network.type) {
      return;
    }

    // try get a peer from the hardcoded ark-ts peerlist (only works for main and devnet)
    arkts.PeerApi
      .findGoodPeer(this._network)
      .subscribe((peer) => this.updateNetwork(peer),
        () => this.toastProvider.error('API.PEER_LIST_ERROR'));
  }

  private async findGoodPeerFromList(peerList: arkts.Peer[]) {
    if (!peerList || !peerList.length) {
      return false;
    }
    const port = +(this._network.p2pPort || this._network.activePeer.port);
    // Force P2P port if specified in the network
    if (this._network.p2pPort) {
      for (const peer of peerList) {
        peer.port = +this._network.p2pPort;
      }
    }
    const peersListSample = peerList.slice(0, 10);
    const preFilteredPeers = lodash.filter(peersListSample, (peer) => {
      if (peer['port'] !== port) {
        return false;
      }

      if (peer.ip === this._network.activePeer.ip || peer.ip === '127.0.0.1') {
        return false;
      }

      return true;
    });

    let filteredPeers = [];
    if (!this._network.isV2) {
      filteredPeers = preFilteredPeers;
    } else {
      const configChecks = [];
      for (const peer of preFilteredPeers) {
        configChecks.push(this.zone.runOutsideAngular(() =>
          this.client.getPeerConfig(peer.ip, peer.port).toPromise()
        ));
      }

      const peerConfigResponses = await Promise.all(configChecks.map(p => p.catch(e => e)));
      for (const peerId in peerConfigResponses) {
        const config = peerConfigResponses[peerId];
        if (config && config.data) {
          const apiConfig: any = lodash.find(config.data.plugins, (_, key) => key.split('/').reverse()[0] === 'core-api');
          if (apiConfig && apiConfig.enabled && apiConfig.port) {
            const peer = preFilteredPeers[peerId];
            peer.port = apiConfig.port;
            if (config.data.version) {
              peer.version = config.data.version;
            }
            filteredPeers.push(peer);
          }
        }
      }
    }

    const missingHeights = [];
    const missingHeightRequests = [];
    for (const peerId in filteredPeers) {
      const peer = filteredPeers[peerId];
      if (!peer.height) {
        missingHeights.push({
          id: peerId,
          peer
        });
        missingHeightRequests.push(this.client.getPeerSyncing(`http://${peer.ip}:${peer.port}`).toPromise());
      }
    }

    if (missingHeightRequests.length) {
      const missingHeightResponses = await Promise.all(missingHeightRequests.map(p => p.catch(e => e)));
      for (const peerId in missingHeightResponses) {
        const response = missingHeightResponses[peerId];
        if (response && response.height) {
          const missingHeight = missingHeights[peerId];
          const peer = missingHeight.peer;
          peer.height = response.height;
          filteredPeers[missingHeight.peerId] = peer;
        }
      }
    }

    const sortedPeers = lodash.orderBy(filteredPeers, ['height', 'delay'], ['desc', 'asc']);
    if (!sortedPeers.length) {
      return false;
    }
    this._network.peerList = sortedPeers;
    this.updateNetwork(sortedPeers[0]);
    return true;
  }

  public fetchDelegates(numberDelegatesToGet: number, getAllDelegates = false): Observable<arkts.Delegate[]> {
    if (!this._api) { return; }
    const limit = this._network.activeDelegates;

    const totalCount = limit;
    let page = 1;

    let totalPages = totalCount / limit;

    let delegates: arkts.Delegate[] = [];

    return Observable.create((observer) => {

      this.client.getDelegateList({ limit, page }).expand(() => {
        const next = this.client.getDelegateList({ limit, page });
        return (page - 1) < totalPages ? next : Observable.empty();
      }).do((response) => {
        if (response.success && getAllDelegates) { numberDelegatesToGet = response.totalCount; }
        totalPages = Math.ceil(numberDelegatesToGet / limit);
        page++;
      }).finally(() => {
        this.storageProvider.set(constants.STORAGE_DELEGATES, delegates);
        this.onUpdateDelegates$.next(delegates);

        observer.next(delegates);
        observer.complete();
      }).subscribe((data) => {
        if (data.success) { delegates = [...delegates, ...data.delegates]; }
      });
    });

  }

  fetchTopWallets(numberWalletsToGet: number, page?: number): Observable<Wallet[]> {
    if (!this._network || !this._network.isV2) {
      return Observable.empty();
    }

    let topWallets: Wallet[] = [];

    const queryParams: HttpParams = HttpUtils.buildQueryParams({ limit : numberWalletsToGet, page: page});

    return Observable.create((observer) => {
      this.httpClient.get<{ data: Wallet[], meta: any }>(`${this._network.getPeerAPIUrl()}/api/v2/wallets/top`, { params: queryParams })
        .subscribe((response) => {
          topWallets = response.data;
          this.onUpdateTopWallets$.next(topWallets);
          observer.next(topWallets);
        });
      }
    );
  }

  public createTransaction(transaction: Transaction, key: string, secondKey: string, secondPassphrase: string): Observable<Transaction> {
    return Observable.create((observer) => {
      const configNetwork = arktsConfig.networks[this._network.name];
      let jsNetwork;
      if (configNetwork) {
        jsNetwork = {
          messagePrefix: configNetwork.name,
          bip32: configNetwork.bip32,
          pubKeyHash: configNetwork.version,
          wif: configNetwork.wif,
        };
      }

      if (!arkts.PublicKey.validateAddress(transaction.address, this._network)) {
        observer.error({
          key: 'API.DESTINATION_ADDRESS_ERROR',
          parameters: {address: transaction.address}
        } as TranslatableObject);
        return observer.complete();
      }

      const wallet = this.userDataProvider.getWalletByAddress(transaction.address);
      transaction.senderId = transaction.address;

      const totalAmount = transaction.getAmount();
      const balance = Number(wallet.balance);
      if (totalAmount > balance) {
        this.toastProvider.error('API.BALANCE_TOO_LOW');
        observer.error({
          key: 'API.BALANCE_TOO_LOW_DETAIL',
          parameters: {
            token: this._network.token,
            fee: ArkUtility.arktoshiToArk(transaction.fee),
            amount: ArkUtility.arktoshiToArk(transaction.amount),
            totalAmount: ArkUtility.arktoshiToArk(totalAmount),
            balance: ArkUtility.arktoshiToArk(balance)
          }
        } as TranslatableObject);
        return observer.complete();
      }

      const epochTime = moment(this._network.epoch).utc().valueOf();
      const now = moment().valueOf();
      transaction.timestamp = Math.floor((now - epochTime) / 1000);

      transaction.signature = null;
      transaction.id = null;

      const keys = this.arkjs.crypto.getKeys(key, jsNetwork);
      this.arkjs.crypto.sign(transaction, keys);

      secondPassphrase = secondKey || secondPassphrase;

      if (secondPassphrase) {
        const secondKeys = this.arkjs.crypto.getKeys(secondPassphrase, jsNetwork);
        this.arkjs.crypto.secondSign(transaction, secondKeys);
      }

      transaction.id = this.arkjs.crypto.getId(transaction);

      observer.next(transaction);
      observer.complete();
    });
  }

  public postTransaction(transaction: arkts.Transaction, peer: arkts.Peer = this._network.activePeer, broadcast: boolean = true) {
    return Observable.create((observer) => {
      const compressTransaction = JSON.parse(JSON.stringify(transaction));
      this.client.postTransaction(compressTransaction, peer).subscribe((result: arkts.TransactionPostResponse) => {
        if (this.isSuccessfulResponse(result)) {
          this.onSendTransaction$.next(transaction);

          if (broadcast) {
            this.broadcastTransaction(transaction);
          }

          observer.next(transaction);
          if (this._network.isV2 && !result.data.accept.length && result.data.broadcast.length) {
            this.toastProvider.warn('TRANSACTIONS_PAGE.WARNING.BROADCAST');
          }
        } else {
          if (broadcast) {
            this.toastProvider.error('API.TRANSACTION_FAILED');
          }
          observer.error(result);
        }
        observer.complete();
      }, (error) => observer.error(error));
    });
  }

  public getDelegateByPublicKey(publicKey: string): Observable<Delegate> {
    if (!publicKey) {
      return Observable.of(null);
    }

    return this.client.getDelegateByPublicKey(publicKey);
  }


  private isSuccessfulResponse (response) {
    const { data, errors } = response;
    const anyDuplicate = errors && Object.keys(errors).some(transactionId => {
      return errors[transactionId].some(item => item.type === 'ERR_DUPLICATE');
    });

    // Ignore "Already in cache" error
    if (anyDuplicate) {
      return true;
    }

    return data && data.invalid.length === 0 && !errors;
  }

  private broadcastTransaction(transaction: arkts.Transaction) {
    if (!this._network.peerList || !this._network.peerList.length) {
      return;
    }

    for (const peer of this._network.peerList.slice(0, 10)) {
      this.postTransaction(transaction, peer, false).subscribe();
    }
  }

  private updateNetwork(peer?: arkts.Peer): void {
    if (peer) {
      this._network.setPeer(peer);
      this.onUpdatePeer$.next(peer);
    }
    // Save in localStorage
    this.userDataProvider.addOrUpdateNetwork(this._network, this.userDataProvider.currentProfile.networkId);
    this._api = new arkts.Client(this._network);
    this._client = new ArkClient(this._network.getPeerAPIUrl(), this.httpClient);

    this.fetchDelegates(this._network.activeDelegates * 2).subscribe((data) => {
      this._delegates = data;
    });

    this.fetchFees().subscribe();
    this.fetchFeeStatistics().subscribe();
    this.fetchNodeConfiguration().subscribe((response: NodeConfigurationResponse) => {
      const { vendorFieldLength, activeDelegates, epoch } = response.data && response.data.constants || {} as NodeConfigurationConstants;

      if (vendorFieldLength) {
        this._network.vendorFieldLength = vendorFieldLength;
      }
      if (activeDelegates) {
        this._network.activeDelegates = activeDelegates;
      }
      if (epoch) {
        this._network.epoch = new Date(epoch);
      }
    });
  }

  private fetchNodeConfiguration(): Observable<NodeConfigurationResponse> {
    if (!this._network || !this._network.isV2) {
      return Observable.empty();
    }

    return Observable.create((observer) => {
      this.httpClient.get(`${this._network.getPeerAPIUrl()}/api/v2/node/configuration`).subscribe((response: NodeConfigurationResponse) => {
        observer.next(response);
      }, e => observer.error(e));
    });
  }

  private fetchFeeStatistics(): Observable<FeeStatistic[]> {
    if (!this._network || !this._network.isV2) {
      return Observable.empty();
    }

    return Observable.create((observer) => {
      this.httpClient.get(
        `${this._network.getPeerAPIUrl()}/api/v2/node/fees?days=7`
      ).subscribe((response: NodeFeesResponse) => {
        const data = response.data;
        // Converts the new response to the old template
        const feeStatistics: FeeStatistic[] = data.map(item => ({
          type: Number(item.type),
          fees: {
            minFee: Number(item.min),
            maxFee: Number(item.max),
            avgFee: Number(item.avg),
          }
        }));

        this._network.feeStatistics = feeStatistics;
        observer.next(feeStatistics);
      }, () => {
        this.fetchNodeConfiguration().subscribe(
          (response: NodeConfigurationResponse) => {
            const data = response.data;
            this._network.feeStatistics = data.feeStatistics;
            observer.next(this._network.feeStatistics);
          },
          e => observer.error(e)
        );
      });
    });
  }

  private fetchFees(): Observable<arkts.Fees> {
    return Observable.create((observer) => {
      this.client.getTransactionFees().subscribe((response) => {
        if (response && response.success) {
          this._fees = response.fees;
          this.storageProvider.set(constants.STORAGE_FEES, this._fees);

          observer.next(this._fees);
        }
      }, () => {
        observer.next(this.storageProvider.getObject(constants.STORAGE_FEES));
      });
    });
  }

  private loadData() {
    this.storageProvider.getObject(constants.STORAGE_DELEGATES).subscribe((delegates) => this._delegates = delegates);
  }

}
