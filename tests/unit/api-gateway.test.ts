/**
 * Unit tests for the API Gateway
 */

import { ApiGateway } from '../../src/core/api-gateway';
import { CircuitBreakerService } from '../../src/services/circuit-breaker';
import { PolicyEngine } from '../../src/services/policy-engine';
import { MetricsCollector } from '../../src/services/metrics-collector';
import { ConfigManager } from '../../src/services/config-manager';
import { Logger } from '../../src/utils/logger';
import { RedisClient } from '../../src/utils/redis-client';
import { Request, Response } from 'express';
import { Event