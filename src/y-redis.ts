import * as Y from 'yjs';
import * as mutex from 'lib0/mutex';
import { Observable } from 'lib0/observable';
import * as promise from 'lib0/promise';
import * as error from 'lib0/error';
import * as logging from 'lib0/logging';
import Redis from 'ioredis';

const logger = logging.createModuleLogger('y-redis');

/**
 * Handles persistence of a sinle doc.
 */
export class PersistenceDoc {
  rp: RedisPersistence;
  name: string;
  doc: Y.Doc;
  mux: mutex.mutex;
  _clock: number;
  _fetchingClock: number;
  synced: Promise<PersistenceDoc>;
  private updateHandler: (update: Uint8Array) => void;

  constructor(rp: RedisPersistence, name: string, doc: Y.Doc) {
    this.rp = rp;
    this.name = name;
    this.doc = doc;
    this.mux = mutex.createMutex();
    /**
     * Next expected index / len of the list of updates
     */
    this._clock = 0;
    this._fetchingClock = 0;

    this.updateHandler = (update) => {
      // mux: only store update in redis if this document update does not originate from redis
      this.mux(() => {
        rp.redis.rpushBuffer(name + ':updates', Buffer.from(update)).then((len) => {
          if (len === this._clock + 1) {
            this._clock++;
            if (this._fetchingClock < this._clock) {
              this._fetchingClock = this._clock;
            }
          }
          rp.redis.publish(this.name, len.toString());
        });
      });
    };
    if (doc.store.clients.size > 0) {
      this.updateHandler(Y.encodeStateAsUpdate(doc));
    }
    doc.on('update', this.updateHandler);
    this.synced = rp.sub.subscribe(name).then(() => this.getUpdates());
  }

  destroy() {
    this.doc.off('update', this.updateHandler);
    this.rp.docs.delete(this.name);
    return this.rp.sub.unsubscribe(this.name);
  }

  /**
   * Get all new updates from redis and increase clock if necessary.
   */
  async getUpdates(): Promise<PersistenceDoc> {
    const startClock = this._clock;
    const updates = await this.rp.redis.lrangeBuffer(this.name + ':updates', startClock, -1);
    logger(
      'Fetched ',
      logging.BOLD,
      logging.PURPLE,
      updates.length.toString().padEnd(2),
      logging.UNBOLD,
      logging.UNCOLOR,
      ' updates',
    );
    this.mux(() => {
      this.doc.transact(() => {
        updates.forEach((update) => {
          Y.applyUpdate(this.doc, update);
        });
        const nextClock = startClock + updates.length;
        if (this._clock < nextClock) {
          this._clock = nextClock;
        }
        if (this._fetchingClock < this._clock) {
          this._fetchingClock = this._clock;
        }
      });
    });
    if (this._fetchingClock <= this._clock) {
      return this;
    } else {
      // there is still something missing. new updates came in. fetch again.
      if (updates.length === 0) {
        // Calling getUpdates recursively has the potential to be an infinite fetch-call.
        // In case no new updates came in, reset _fetching clock (in case the pubsub lied / send an invalid message).
        // Being overly protective here..
        this._fetchingClock = this._clock;
      }
      return this.getUpdates();
    }
  }
}

const createRedisInstance = (
  redisOpts: Object | null,
  redisClusterOpts: Array<Object> | null,
): Redis.Redis | Redis.Cluster =>
  redisClusterOpts ? new Redis.Cluster(redisClusterOpts) : redisOpts ? new Redis(redisOpts) : new Redis();

export class RedisPersistence extends Observable<string> {
  redis: Redis.Redis | Redis.Cluster;
  sub: Redis.Redis | Redis.Cluster;
  docs: Map<string, PersistenceDoc>;

  constructor(
    { redisOpts, redisClusterOpts }: { redisOpts: Object | null; redisClusterOpts: Array<Object> | null } = {
      redisOpts: null,
      redisClusterOpts: null,
    },
  ) {
    super();
    this.redis = createRedisInstance(redisOpts, redisClusterOpts);
    this.sub = createRedisInstance(redisOpts, redisClusterOpts);
    this.docs = new Map<string, PersistenceDoc>();
    this.sub.on('message', (channel: string, sclock: string) => {
      // console.log('message', channel, sclock)
      const pdoc = this.docs.get(channel);
      if (pdoc) {
        const clock = Number(sclock) || Number.POSITIVE_INFINITY; // case of null
        if (pdoc._fetchingClock < clock) {
          // do not query doc updates if this document is currently already fetching
          const isCurrentlyFetching = pdoc._fetchingClock !== pdoc._clock;
          if (pdoc._fetchingClock < clock) {
            pdoc._fetchingClock = clock;
          }
          if (!isCurrentlyFetching) {
            pdoc.getUpdates();
          }
        }
      } else {
        this.sub.unsubscribe(channel);
      }
    });
  }

  bindState(name: string, ydoc: Y.Doc): PersistenceDoc {
    if (this.docs.has(name)) {
      throw error.create(`"${name}" is already bound to this RedisPersistence instance`);
    }
    const pd = new PersistenceDoc(this, name, ydoc);
    this.docs.set(name, pd);
    return pd;
  }

  async destroy() {
    const docs = this.docs;
    this.docs = new Map();
    await promise.all(Array.from(docs.values()).map((doc) => doc.destroy()));
    this.redis.quit();
    this.sub.quit();
    // @ts-ignore
    this.redis = null;
    // @ts-ignore
    this.sub = null;
  }

  closeDoc(name: string) {
    const doc = this.docs.get(name);
    if (doc) {
      return doc.destroy();
    }
  }

  clearDocument(name: string) {
    const doc = this.docs.get(name);
    if (doc) {
      doc.destroy();
    }
    return this.redis.del(name + ':updates');
  }

  /**
   * Destroys this instance and removes all known documents from the database.
   * After that this Persistence instance is destroyed.
   *
   * @return {Promise<any>}
   */
  clearAllDocuments() {
    return promise.all(Array.from(this.docs.keys()).map((name) => this.redis.del(name + ':updates'))).then(() => {
      this.destroy();
    });
  }
}
