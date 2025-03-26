export interface RouteConfig {
    id?: string;
    name: string;
    pattern: string;
    target: string;
    methods?: string[];
    policies?: string[];
    circuitBreaker?: CircuitBreakerConfig;
    caching?: CachingConfig;
    loadBalancing?: LoadBalancingConfig;
    timeout?: number;
    retries?: number;
    transformation?: TransformationConfig;
  }
  
  export interface Route extends RouteConfig {
    id: string;
  }
  
  export interface CircuitBreakerConfig {
    failureThreshold: number;
    resetTimeout: number;
    successesBeforeReset?: number;
    distributed?: boolean;
  }
  
  export enum CircuitState {
    CLOSED = 0,
    OPEN = 1,
    HALF_OPEN = 2
  }
  
  export interface ServiceHealth {
    state: CircuitState;
    failures: number;
    lastFailure: string | null;
    nextAttempt: string | null;
    config: {
      failureThreshold: number;
      resetTimeout: number;
      successesBeforeReset: number;
    };
  }
  
  export interface FailureEvent {
    serviceId: string;
    timestamp: number;
    error: string;
    errorType: string;
    state: CircuitState;
  }
  
  export interface CachingConfig {
    enabled: boolean;
    ttl: number;
    keyGenerator?: string;
  }
  
  export interface LoadBalancingConfig {
    strategy: 'round-robin' | 'least-connections' | 'ip-hash';
    healthCheck?: {
      path: string;
      interval: number;
      timeout: number;
      unhealthyThreshold: number;
      healthyThreshold: number;
    };
  }
  
  export interface TransformationConfig {
    request?: {
      template?: string;
      function?: string;
    };
    response?: {
      template?: string;
      function?: string;
    };
  }