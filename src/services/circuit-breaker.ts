/**
 * EnterpriseFlow - Advanced Circuit Breaker Implementation
 * 
 * This implements the circuit breaker pattern with advanced features:
 * - Configurable thresholds and timeouts
 * - Half-open state for testing recovery
 * - Metrics tracking for failure analysis
 * - Health status reporting for observability
 * - Event emission for system monitoring
 */

import { EventEmitter } from 'events';
import { CircuitBreakerConfig, CircuitState, ServiceHealth, FailureEvent } from '../types';
import { Logger } from '../utils/logger';
import { MetricsCollector } from './metrics-collector';
import { RedisClient } from '../utils/redis-client';

export class CircuitBreakerService {
  private breakers: Map<string, CircuitBreaker> = new Map();
  private readonly logger: Logger;
  private readonly metrics: MetricsCollector;
  private readonly redis: RedisClient;
  private readonly eventEmitter: EventEmitter;

  constructor(
    logger: Logger,
    metrics: MetricsCollector,
    redis: RedisClient,
    eventEmitter: EventEmitter
  ) {
    this.logger = logger;
    this.metrics = metrics;
    this.redis = redis;
    this.eventEmitter = eventEmitter;
  }

  /**
   * Register a new circuit breaker for a service
   */
  public register(serviceId: string, config: CircuitBreakerConfig): void {
    if (this.breakers.has(serviceId)) {
      this.logger.warn(`Circuit breaker for service ${serviceId} already exists, updating configuration`);
      const existingBreaker = this.breakers.get(serviceId);
      existingBreaker!.updateConfig(config);
      return;
    }

    const breaker = new CircuitBreaker(
      serviceId,
      config,
      this.logger,
      this.metrics,
      this.redis,
      this.eventEmitter
    );
    
    this.breakers.set(serviceId, breaker);
    this.logger.info(`Registered circuit breaker for service ${serviceId} with failure threshold ${config.failureThreshold}`);
  }

  /**
   * Check if a request is allowed to proceed
   */
  public isAllowed(serviceId: string): boolean {
    const breaker = this.breakers.get(serviceId);
    if (!breaker) {
      this.logger.warn(`No circuit breaker found for service ${serviceId}, allowing request`);
      return true;
    }
    
    return breaker.isAllowed();
  }

  /**
   * Record a successful request
   */
  public recordSuccess(serviceId: string): void {
    const breaker = this.breakers.get(serviceId);
    if (breaker) {
      breaker.recordSuccess();
    }
  }

  /**
   * Record a failed request
   */
  public recordFailure(serviceId: string, error: Error): void {
    const breaker = this.breakers.get(serviceId);
    if (breaker) {
      breaker.recordFailure(error);
    }
  }

  /**
   * Get health status for all circuit breakers
   */
  public getHealth(): Record<string, ServiceHealth> {
    const health: Record<string, ServiceHealth> = {};
    
    this.breakers.forEach((breaker, serviceId) => {
      health[serviceId] = breaker.getHealth();
    });
    
    return health;
  }

  /**
   * Reset a circuit breaker to closed state
   */
  public reset(serviceId: string): boolean {
    const breaker = this.breakers.get(serviceId);
    if (breaker) {
      breaker.reset();
      this.logger.info(`Manually reset circuit breaker for service ${serviceId}`);
      return true;
    }
    return false;
  }
}

class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failures: number = 0;
  private lastFailureTime: number = 0;
  private readonly serviceId: string;
  private config: CircuitBreakerConfig;
  private readonly logger: Logger;
  private readonly metrics: MetricsCollector;
  private readonly redis: RedisClient;
  private readonly eventEmitter: EventEmitter;
  private nextAttemptTime: number = 0;

  constructor(
    serviceId: string,
    config: CircuitBreakerConfig,
    logger: Logger,
    metrics: MetricsCollector,
    redis: RedisClient,
    eventEmitter: EventEmitter
  ) {
    this.serviceId = serviceId;
    this.config = config;
    this.logger = logger;
    this.metrics = metrics;
    this.redis = redis;
    this.eventEmitter = eventEmitter;
    
    // Initialize from Redis if using distributed circuit breaker
    if (this.config.distributed) {
      this.initializeFromRedis();
    }
  }

  /**
   * Initialize state from Redis for distributed circuit breakers
   */
  private async initializeFromRedis(): Promise<void> {
    try {
      const state = await this.redis.get(`circuit:${this.serviceId}:state`);
      if (state) {
        this.state = parseInt(state);
        this.failures = parseInt(await this.redis.get(`circuit:${this.serviceId}:failures`) || '0');
        this.lastFailureTime = parseInt(await this.redis.get(`circuit:${this.serviceId}:lastFailure`) || '0');
        this.nextAttemptTime = parseInt(await this.redis.get(`circuit:${this.serviceId}:nextAttempt`) || '0');
        
        this.logger.info(`Initialized distributed circuit breaker for ${this.serviceId} from Redis: state=${this.state}, failures=${this.failures}`);
      }
    } catch (error) {
      this.logger.error(`Error initializing circuit breaker from Redis`, error);
    }
  }

  /**
   * Update circuit breaker configuration
   */
  public updateConfig(config: CircuitBreakerConfig): void {
    this.config = { ...this.config, ...config };
    this.logger.info(`Updated configuration for circuit breaker ${this.serviceId}`);
  }

  /**
   * Check if a request is allowed to proceed
   */
  public isAllowed(): boolean {
    const now = Date.now();
    
    switch (this.state) {
      case CircuitState.CLOSED:
        return true;
        
      case CircuitState.OPEN:
        // Check if it's time to try again
        if (now >= this.nextAttemptTime) {
          this.state = CircuitState.HALF_OPEN;
          this.logger.info(`Circuit for service ${this.serviceId} moved to HALF_OPEN state for testing`);
          this.updateState();
          
          this.eventEmitter.emit('circuit:state-change', {
            serviceId: this.serviceId,
            state: CircuitState.HALF_OPEN,
            timestamp: now
          });
          
          return true;
        }
        return false;
        
      case CircuitState.HALF_OPEN:
        // In half-open state, only allow one test request
        return true;
        
      default:
        return true;
    }
  }

  /**
   * Record a successful request
   */
  public recordSuccess(): void {
    const now = Date.now();
    
    if (this.state === CircuitState.HALF_OPEN) {
      // If successful in half-open state, reset and close the circuit
      this.reset();
      this.logger.info(`Service ${this.serviceId} has recovered, circuit closed`);
      
      this.eventEmitter.emit('circuit:state-change', {
        serviceId: this.serviceId,
        state: CircuitState.CLOSED,
        timestamp: now
      });
    }
    
    // In closed state with failures, decrement the failure count
    if (this.state === CircuitState.CLOSED && this.failures > 0) {
      this.failures = Math.max(0, this.failures - this.config.successesBeforeReset);
      this.updateState();
    }
    
    // Record metrics
    this.metrics.recordCircuitBreakerSuccess(this.serviceId);
  }

  /**
   * Record a failed request
   */
  public recordFailure(error: Error): void {
    const now = Date.now();
    this.lastFailureTime = now;
    this.failures++;
    
    const failureEvent: FailureEvent = {
      serviceId: this.serviceId,
      timestamp: now,
      error: error.message,
      errorType: error.constructor.name,
      state: this.state
    };
    
    // Record metrics
    this.metrics.recordCircuitBreakerFailure(this.serviceId, error);
    
    // Emit failure event
    this.eventEmitter.emit('circuit:failure', failureEvent);
    
    if (this.state === CircuitState.CLOSED && this.failures >= this.config.failureThreshold) {
      // Too many failures, open the circuit
      this.state = CircuitState.OPEN;
      this.nextAttemptTime = now + this.config.resetTimeout;
      
      this.logger.warn(`Circuit for service ${this.serviceId} opened after ${this.failures} failures, will try again in ${this.config.resetTimeout}ms`);
      
      this.eventEmitter.emit('circuit:state-change', {
        serviceId: this.serviceId,
        state: CircuitState.OPEN,
        timestamp: now,
        failures: this.failures,
        nextAttemptTime: this.nextAttemptTime
      });
    } else if (this.state === CircuitState.HALF_OPEN) {
      // Failed during test request, back to open state
      this.state = CircuitState.OPEN;
      this.nextAttemptTime = now + this.config.resetTimeout;
      
      this.logger.warn(`Test request for service ${this.serviceId} failed, circuit re-opened for ${this.config.resetTimeout}ms`);
      
      this.eventEmitter.emit('circuit:state-change', {
        serviceId: this.serviceId,
        state: CircuitState.OPEN,
        timestamp: now,
        failures: this.failures,
        nextAttemptTime: this.nextAttemptTime
      });
    }
    
    this.updateState();
  }

  /**
   * Update distributed state in Redis if enabled
   */
  private async updateState(): Promise<void> {
    if (!this.config.distributed) {
      return;
    }
    
    try {
      const multi = this.redis.multi();
      multi.set(`circuit:${this.serviceId}:state`, this.state.toString());
      multi.set(`circuit:${this.serviceId}:failures`, this.failures.toString());
      multi.set(`circuit:${this.serviceId}:lastFailure`, this.lastFailureTime.toString());
      multi.set(`circuit:${this.serviceId}:nextAttempt`, this.nextAttemptTime.toString());
      
      // Set expiration on keys
      const expiryTime = Math.max(
        this.config.resetTimeout * 2, 
        30 * 60 * 1000 // Min 30 minutes
      );
      
      multi.expire(`circuit:${this.serviceId}:state`, Math.floor(expiryTime / 1000));
      multi.expire(`circuit:${this.serviceId}:failures`, Math.floor(expiryTime / 1000));
      multi.expire(`circuit:${this.serviceId}:lastFailure`, Math.floor(expiryTime / 1000));
      multi.expire(`circuit:${this.serviceId}:nextAttempt`, Math.floor(expiryTime / 1000));
      
      await multi.exec();
    } catch (error) {
      this.logger.error(`Error updating circuit breaker state in Redis`, error);
    }
  }

  /**
   * Reset the circuit breaker to closed state
   */
  public reset(): void {
    this.state = CircuitState.CLOSED;
    this.failures = 0;
    this.nextAttemptTime = 0;
    this.updateState();
    
    this.eventEmitter.emit('circuit:reset', {
      serviceId: this.serviceId,
      timestamp: Date.now()
    });
  }

  /**
   * Get health status information
   */
  public getHealth(): ServiceHealth {
    return {
      state: this.state,
      failures: this.failures,
      lastFailure: this.lastFailureTime > 0 ? new Date(this.lastFailureTime).toISOString() : null,
      nextAttempt: this.nextAttemptTime > 0 ? new Date(this.nextAttemptTime).toISOString() : null,
      config: {
        failureThreshold: this.config.failureThreshold,
        resetTimeout: this.config.resetTimeout,
        successesBeforeReset: this.config.successesBeforeReset
      }
    };
  }
}