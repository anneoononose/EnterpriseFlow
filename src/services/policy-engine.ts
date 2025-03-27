/**
 * EnterpriseFlow - Policy Engine Service
 */

import { Request } from 'express';
import { Logger } from '../utils/logger';
import { RedisClient } from '../utils/redis-client';
import jwt from 'jsonwebtoken';

export interface PolicyConfig {
  name: string;
  type: string;
  config: Record<string, any>;
}

export interface PolicyResult {
  allowed: boolean;
  statusCode?: number;
  error?: string;
  reason?: string;
  policyName?: string;
}

export class PolicyEngine {
  private policies: Map<string, Policy> = new Map();
  private readonly logger: Logger;
  private readonly redis: RedisClient;

  constructor(logger: Logger, redis: RedisClient) {
    this.logger = logger;
    this.redis = redis;
    
    // Register built-in policies
    this.registerBuiltInPolicies();
  }
  
  /**
   * Register built-in policies
   */
  private registerBuiltInPolicies(): void {
    this.registerPolicy(new AuthenticationPolicy(this.logger));
    this.registerPolicy(new RateLimitingPolicy(this.logger, this.redis));
    this.registerPolicy(new IPFilteringPolicy(this.logger));
    
    this.logger.info(`Registered ${this.policies.size} built-in policies`);
  }
  
  /**
   * Register a policy
   */
  public registerPolicy(policy: Policy): void {
    this.policies.set(policy.getName(), policy);
    this.logger.info(`Registered policy: ${policy.getName()}`);
  }
  
  /**
   * Get a policy by name
   */
  public getPolicy(name: string): Policy | undefined {
    return this.policies.get(name);
  }
  
  /**
   * Apply policies to a request
   */
  public async applyPolicies(
    policyNames: string[],
    req: Request,
    context: Record<string, any> = {}
  ): Promise<PolicyResult> {
    for (const policyName of policyNames) {
      const policy = this.getPolicy(policyName);
      
      if (!policy) {
        this.logger.warn(`Policy not found: ${policyName}`);
        continue;
      }
      
      try {
        const result = await policy.evaluate(req, context);
        
        if (!result.allowed) {
          this.logger.info(`Request rejected by policy ${policyName}: ${result.reason}`);
          return {
            ...result,
            policyName
          };
        }
      } catch (error) {
        this.logger.error(`Error evaluating policy ${policyName}`, error);
        return {
          allowed: false,
          statusCode: 500,
          error: 'Internal Server Error',
          reason: 'Error evaluating policy',
          policyName
        };
      }
    }
    
    return { allowed: true };
  }
}

/**
 * Base Policy interface
 */
export interface Policy {
  getName(): string;
  getType(): string;
  evaluate(req: Request, context: Record<string, any>): Promise<PolicyResult>;
}

/**
 * Authentication Policy
 */
export class AuthenticationPolicy implements Policy {
  private readonly logger: Logger;
  
  constructor(logger: Logger) {
    this.logger = logger;
  }
  
  getName(): string {
    return 'authentication';
  }
  
  getType(): string {
    return 'security';
  }
  
  async evaluate(req: Requestreq: Request, _context: Record<string, any>): Promise<PolicyResult> {
    // Check for authentication header
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
      return {
        allowed: false,
        statusCode: 401,
        error: 'Unauthorized',
        reason: 'Missing authentication header'
      };
    }
    
    // Handle different auth types
    if (authHeader.startsWith('Bearer ')) {
      return this.evaluateJwt(authHeader.substring(7), req);
    } else if (authHeader.startsWith('ApiKey ')) {
      return this.evaluateApiKey(authHeader.substring(7), req);
    }
    
    return {
      allowed: false,
      statusCode: 401,
      error: 'Unauthorized',
      reason: 'Unsupported authentication method'
    };
  }
  
  private async evaluateJwt(token: string, req: Request): Promise<PolicyResult> {
    try {
      // In a real implementation, you'd validate against proper secret and options
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'development_secret');
      
      // Attach user info to request for downstream handlers
      (req as any).user = decoded;
      
      return { allowed: true };
    } catch (error) {
      this.logger.warn('JWT validation failed', error);
      
      return {
        allowed: false,
        statusCode: 401,
        error: 'Unauthorized',
        reason: 'Invalid or expired token'
      };
    }
  }
  
  private async evaluateApiKey(apiKey: string, _req: Request): Promise<PolicyResult> {
    // In a real implementation, you'd validate against a database or service
    const validApiKey = process.env.API_KEY || 'development_api_key';
    
    if (apiKey === validApiKey) {
      return { allowed: true };
    }
    
    return {
      allowed: false,
      statusCode: 401,
      error: 'Unauthorized',
      reason: 'Invalid API key'
    };
  }
}

/**
 * Rate Limiting Policy
 */
export class RateLimitingPolicy implements Policy {
  private readonly logger: Logger;
  private readonly redis: RedisClient;
  
  constructor(logger: Logger, redis: RedisClient) {
    this.logger = logger;
    this.redis = redis;
  }
  
  getName(): string {
    return 'rate-limiting';
  }
  
  getType(): string {
    return 'traffic-management';
  }
  
  async evaluate(req: Request, context: Record<string, any>): Promise<PolicyResult> {
    const clientIp = req.ip || '0.0.0.0';
    const route = context.route || 'default';
    
    // Default rate limit: 100 requests per minute
    const limit = context.rateLimit?.limit || 100;
    const windowSec = context.rateLimit?.windowSec || 60;
    
    const key = `ratelimit:${route}:${clientIp}`;
    
    try {
      // Get current count
      const count = parseInt(await this.redis.get(key) || '0', 10);
      
      if (count >= limit) {
        return {
          allowed: false,
          statusCode: 429,
          error: 'Too Many Requests',
          reason: `Rate limit of ${limit} requests per ${windowSec} seconds exceeded`
        };
      }
      
      // Increment count
      await this.redis.set(key, (count + 1).toString());
      
      // Set expiry if new key
      if (count === 0) {
        await this.redis.expire(key, windowSec);
      }
      
      return { allowed: true };
    } catch (error) {
      // Log error but allow request to proceed in case of Redis failure
      this.logger.error('Error evaluating rate limit', error);
      return { allowed: true };
    }
  }
}

/**
 * IP Filtering Policy
 */
export class IPFilteringPolicy implements Policy {
  private readonly logger: Logger;
  private blacklist: string[] = [];
  private whitelist: string[] = [];
  
  constructor(logger: Logger) {
    this.logger = logger;
    
    // Load from environment variables
    if (process.env.IP_BLACKLIST) {
      this.blacklist = process.env.IP_BLACKLIST.split(',');
    }
    
    if (process.env.IP_WHITELIST) {
      this.whitelist = process.env.IP_WHITELIST.split(',');
    }
  }
  
  getName(): string {
    return 'ip-filtering';
  }
  
  getType(): string {
    return 'security';
  }
  
  async evaluate(req: Request, _context: Record<string, any>): Promise<PolicyResult> {
    const clientIp = req.ip || '0.0.0.0';
    
    // Whitelist takes precedence
    if (this.whitelist.length > 0 && !this.whitelist.includes(clientIp)) {
      return {
        allowed: false,
        statusCode: 403,
        error: 'Forbidden',
        reason: 'IP address not in whitelist'
      };
    }
    
    // Check blacklist
    if (this.blacklist.includes(clientIp)) {
      return {
        allowed: false,
        statusCode: 403,
        error: 'Forbidden',
        reason: 'IP address is blacklisted'
      };
    }
    
    return { allowed: true };
  }
}