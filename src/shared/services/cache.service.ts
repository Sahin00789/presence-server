import { DOMAIN_EVENT_CHANNEL, DomainEvent, domainEventBus } from './event-bus.js';

interface CacheEntry<T = unknown> {
  value: T;
  expiresAt: number;
  tags: Set<string>;
}

export interface CacheOptions {
  /** Time to live in milliseconds. Defaults to 60,000ms (1 minute). */
  ttlMs?: number;
  /** Organizational or domain tags associated with this cache key. */
  tags?: string[];
}

export class CacheService {
  private cache = new Map<string, CacheEntry>();
  private tagToKeys = new Map<string, Set<string>>();
  private inflightRequests = new Map<string, Promise<unknown>>();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly defaultTtlMs: number;
  private readonly maxEntries: number;

  constructor(options?: { defaultTtlMs?: number; maxEntries?: number }) {
    this.defaultTtlMs = options?.defaultTtlMs ?? 60_000;
    this.maxEntries = options?.maxEntries ?? 5_000;

    // Periodic cleanup every 30 seconds to remove expired entries
    this.cleanupInterval = setInterval(() => this.pruneExpired(), 30_000);
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }

    // Subscribe to process domain events to automatically invalidate cache tags
    domainEventBus.on(DOMAIN_EVENT_CHANNEL, this.handleDomainEvent.bind(this));
  }

  /**
   * Retrieves a cached value if present and not expired.
   */
  get<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.deleteKey(key);
      return undefined;
    }

    return entry.value as T;
  }

  /**
   * Stores a value in cache tagged with domain identifiers.
   */
  set<T>(key: string, value: T, options?: CacheOptions): void {
    if (this.cache.size >= this.maxEntries) {
      this.evictOldest();
    }

    const ttlMs = options?.ttlMs ?? this.defaultTtlMs;
    const expiresAt = Date.now() + ttlMs;
    const tags = new Set(options?.tags ?? []);

    // Remove existing tags for this key if it's being updated
    this.removeKeyFromTags(key);

    const entry: CacheEntry = {
      value,
      expiresAt,
      tags,
    };

    this.cache.set(key, entry);

    // Index tags
    for (const tag of tags) {
      let keys = this.tagToKeys.get(tag);
      if (!keys) {
        keys = new Set();
        this.tagToKeys.set(tag, keys);
      }
      keys.add(key);
    }
  }

  /**
   * Request Coalescing (Single-Flight): If the key is cached, returns it.
   * Otherwise, executes the fetcher function once and shares the resulting Promise
   * among all concurrent callers for the same key.
   */
  async getOrFetch<T>(
    key: string,
    fetcher: () => Promise<T>,
    options?: CacheOptions
  ): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) {
      return cached;
    }

    const existingInflight = this.inflightRequests.get(key);
    if (existingInflight) {
      return (await existingInflight) as T;
    }

    const fetchPromise = (async () => {
      try {
        const result = await fetcher();
        this.set(key, result, options);
        return result;
      } finally {
        this.inflightRequests.delete(key);
      }
    })();

    this.inflightRequests.set(key, fetchPromise);
    return fetchPromise;
  }

  /**
   * Invalidates a specific cache key.
   */
  invalidateKey(key: string): void {
    this.deleteKey(key);
  }

  /**
   * Invalidates all cache keys associated with a given tag (e.g., `org:123:shifts`).
   */
  invalidateTag(tag: string): void {
    const keys = this.tagToKeys.get(tag);
    if (!keys) return;

    for (const key of Array.from(keys)) {
      this.deleteKey(key);
    }
    this.tagToKeys.delete(tag);
  }

  /**
   * Invalidates multiple cache tags at once.
   */
  invalidateTags(tags: string[]): void {
    for (const tag of tags) {
      this.invalidateTag(tag);
    }
  }

  /**
   * Invalidates cache keys matching a string substring or regular expression.
   */
  invalidatePattern(pattern: RegExp | string): void {
    const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
    for (const key of Array.from(this.cache.keys())) {
      if (regex.test(key)) {
        this.deleteKey(key);
      }
    }
  }

  /**
   * Clears all cached entries.
   */
  clear(): void {
    this.cache.clear();
    this.tagToKeys.clear();
    this.inflightRequests.clear();
  }

  /**
   * Destroys the cache instance and clears timers.
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    domainEventBus.off(DOMAIN_EVENT_CHANNEL, this.handleDomainEvent.bind(this));
    this.clear();
  }

  /**
   * Listener for domain events emitted via `publishDomainEvent`.
   * Automatically invalidates relevant cached data tags across all org modules.
   */
  private handleDomainEvent(event: DomainEvent): void {
    const { type, organizationId, userIds } = event;
    const orgTag = `org:${organizationId}`;

    switch (type) {
      case 'wallet_update':
        this.invalidateTag(`${orgTag}:wallet`);
        this.invalidateTag(`${orgTag}:dashboard`);
        if (userIds) {
          for (const uid of userIds) {
            this.invalidateTag(`user:${uid}:wallet`);
          }
        }
        break;

      case 'attendance_update':
        this.invalidateTag(`${orgTag}:attendance`);
        this.invalidateTag(`${orgTag}:dashboard`);
        if (userIds) {
          for (const uid of userIds) {
            this.invalidateTag(`user:${uid}:attendance`);
          }
        }
        break;

      case 'shift_update':
        this.invalidateTag(`${orgTag}:shifts`);
        this.invalidateTag(`${orgTag}:dashboard`);
        break;

      case 'premises_update':
        this.invalidateTag(`${orgTag}:premises`);
        break;

      case 'staff_update':
        this.invalidateTag(`${orgTag}:staff`);
        this.invalidateTag(`${orgTag}:dashboard`);
        if (userIds) {
          for (const uid of userIds) {
            this.invalidateTag(`user:${uid}:staff`);
          }
        }
        break;

      case 'payroll_update':
        this.invalidateTag(`${orgTag}:payroll`);
        this.invalidateTag(`${orgTag}:wallet`);
        this.invalidateTag(`${orgTag}:dashboard`);
        break;

      case 'leave_update':
        this.invalidateTag(`${orgTag}:leave`);
        this.invalidateTag(`${orgTag}:dashboard`);
        break;

      case 'location_check_updated':
      case 'exception_raised':
        this.invalidateTag(`${orgTag}:location`);
        this.invalidateTag(`${orgTag}:attendance`);
        this.invalidateTag(`${orgTag}:dashboard`);
        break;

      default:
        // Broadcast invalidation for generic organization updates
        this.invalidateTag(orgTag);
        break;
    }
  }

  private deleteKey(key: string): void {
    this.removeKeyFromTags(key);
    this.cache.delete(key);
  }

  private removeKeyFromTags(key: string): void {
    const entry = this.cache.get(key);
    if (!entry) return;

    for (const tag of entry.tags) {
      const keys = this.tagToKeys.get(tag);
      if (keys) {
        keys.delete(key);
        if (keys.size === 0) {
          this.tagToKeys.delete(tag);
        }
      }
    }
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.deleteKey(key);
      }
    }
  }

  private evictOldest(): void {
    const firstKey = this.cache.keys().next().value;
    if (firstKey) {
      this.deleteKey(firstKey);
    }
  }
}

export const cacheService = new CacheService();
