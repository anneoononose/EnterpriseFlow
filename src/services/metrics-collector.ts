/**
 * EnterpriseFlow - Metrics Collector Service
 */

import client from 'prom-client';
import { Logger } from '../utils/logger';

export class MetricsCollector {
  private register: client.Registry;
  private apiRequestsCounter: client.Counter<string>;
  private apiResponseTimeHistogram: client.Histogram<string>;
  private circuitBreakerStateGauge: client.Gauge<string>;
  private circuitBreakerFailuresCounter: client.Counter<string>;
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
    
    // Create a registry
    this.register = new client.Registry();
    
    // Add default metrics
    client.collectDefaultMetrics({ register: this.register });
    
    // API Request Counter
    this.apiRequestsCounter = new client.Counter({
      name: 'enterpriseflow_api_requests_total',
      help: 'Total number of API requests',
      labelNames: ['route', 'method', 'status_code'] as const,
      registers: [this.register]
    });
    
    // API Response Time Histogram
    this.apiResponseTimeHistogram = new client.Histogram({
      name: 'enterpriseflow_api_response_time_seconds',
      help: 'API response time in seconds',
      labelNames: ['route', 'method'] as const,
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
      registers: [this.register]
    });
    
    // Circuit Breaker State Gauge
    this.circuitBreakerStateGauge = new client.Gauge({
      name: 'enterpriseflow_circuit_breaker_state',
      help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
      labelNames: ['service_id'] as const,
      registers: [this.register]
    });
    
    // Circuit Breaker Failures Counter
    this.circuitBreakerFailuresCounter = new client.Counter({
      name: 'enterpriseflow_circuit_breaker_failures_total',
      help: 'Total number of circuit breaker failures',
      labelNames: ['service_id', 'error_type'] as const,
      registers: [this.register]
    });
    
    this.logger.info('Metrics collector initialized');
  }
  
  /**
   * Record API request information
   */
  public recordRequest(data: {
    routeId: string;
    routeName: string;
    requestId: string;
    method: string;
    path: string;
    statusCode: number;
    responseTime: number;
    cacheHit?: boolean;
  }): void {
    try {
      // Increment request counter
      this.apiRequestsCounter.inc({
        route: data.routeName,
        method: data.method,
        status_code: data.statusCode.toString()
      });
      
      // Record response time
      this.apiResponseTimeHistogram.observe(
        {
          route: data.routeName,
          method: data.method
        },
        data.responseTime / 1000 // Convert to seconds
      );
    } catch (error) {
      this.logger.error('Error recording metrics', error);
    }
  }
  
  /**
   * Record circuit breaker success
   */
  public recordCircuitBreakerSuccess(serviceId: string): void {
    try {
      // We don't increment a counter for successes, but update the state
      this.circuitBreakerStateGauge.set({ service_id: serviceId }, 0); // 0 = CLOSED
    } catch (error) {
      this.logger.error('Error recording circuit breaker success', error);
    }
  }
  
  /**
   * Record circuit breaker failure
   */
  public recordCircuitBreakerFailure(serviceId: string, error: Error): void {
    try {
      // Increment failures counter
      this.circuitBreakerFailuresCounter.inc({
        service_id: serviceId,
        error_type: error.constructor.name
      });
    } catch (error) {
      this.logger.error('Error recording circuit breaker failure', error);
    }
  }
  
  /**
   * Update circuit breaker state
   */
  public setCircuitBreakerState(serviceId: string, state: number): void {
    try {
      this.circuitBreakerStateGauge.set({ service_id: serviceId }, state);
    } catch (error) {
      this.logger.error('Error setting circuit breaker state', error);
    }
  }
  
  /**
   * Get metrics as string for Prometheus scraping
   */
  public async getMetrics(): Promise<string> {
    return this.register.metrics();
  }
  
  /**
   * Get metrics as JSON
   */
  public async getMetricsAsJson(): Promise<client.Registry.Metrics> {
    return this.register.getMetricsAsJSON();
  }
  
  /**
   * Clear all metrics
   */
  public clearMetrics(): void {
    this.register.clear();
  }
}