/// <reference lib="webworker" />

interface KeyCache<T> {
  init(): Promise<void>;
  put(key: string, value: T, ...args: unknown[]): Promise<void>;
  cached(key: string, ...args: unknown[]): Promise<T | undefined>;
  cachedOr(key: string, get: () => Promise<T>, ...args: unknown[]): Promise<T>;
  bust(key: string): Promise<boolean>;
}

export class ResponseKeyCache implements KeyCache<Response> {
  cacheName: string;
  _cache?: Cache = undefined;

  constructor(cacheName: string) {
    this.cacheName = cacheName;
  }

  public async init() {
    this._cache = this._cache ?? await caches.open(this.cacheName);
  }

  public async put(key: string, value: Response) {
    if (!this._cache) throw Error('Cache not initialized');

    return await this._cache.put(key, value);
  }

  public async cached(key: string) {
    if (!this._cache) throw Error('Cache not initialized');

    return await this._cache.match(key);
  }

  public async cachedOr(key: string, get: () => Promise<Response>) {
    if (!this._cache) throw Error('Cache not initialized');

    let response = await this._cache.match(key);
    if (!response) {
      response = await get();
      this._cache.put(key, response.clone());
    }
    return response;
  }

  public async bust(key: string) {
    if (!this._cache) throw Error('Cache not initialized');

    return await this._cache.delete(key);
  }
}

export class WrappedResponseKeyCache implements KeyCache<unknown> {
  cacheName: string;
  _cache?: Cache;

  constructor(cacheName: string) {
    this.cacheName = cacheName;
  }

  public async init() {
    this._cache = this._cache ?? await caches.open(this.cacheName);
  }

  public async put<T>(key: string, value: T, serialize: (data: T) => Promise<Response>) {
    if (!this._cache) throw Error('Cache not initialized');

    const response = await serialize(value);
    return await this._cache.put(key, response);
  }

  public async cached<T>(key: string, deserialize: (response: Response) => Promise<T | undefined>) {
    if (!this._cache) throw Error('Cache not initialized');

    const response = await this._cache.match(key);
    if (!response) return undefined;

    return await deserialize(response);
  }

  public async cachedOr<T>(
    key: string,
    get: () => Promise<T>,
    deserialize: (response: Response) => Promise<T>,
    serialize: (data: T) => Promise<Response>,
  ) {
    if (!this._cache) throw Error('Cache not initialized');

    let response = await this._cache.match(key);
    if (!response) {
      const data = await get();
      response = await serialize(data);
      this._cache.put(key, response);
      return data;
    }
    return deserialize(response);
  }

  public async bust(key: string) {
    if (!this._cache) throw Error('Cache not initialized');

    return await this._cache.delete(key);
  }
}
