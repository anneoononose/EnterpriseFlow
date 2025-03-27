/**
 * EnterpriseFlow - Configuration Manager Service
 */

import fs from 'fs/promises';
import path from 'path';
import { RouteConfig } from '../types';
import { Logger } from '../utils/logger';
import { RedisClient } from '../utils/redis-client';

export class ConfigManager {
  private readonly logger: Logger;
  private readonly redis: RedisClient;
  private configDir: string;
  private routes: RouteConfig[] = [];
  private isInitialized: boolean = false;
  
  constructor(logger: Logger, redis: RedisClient, configDir?: string) {
    this.logger = logger;
    this.redis = redis;
    this.configDir = configDir || path.join(process.cwd(), 'config');
  }
  
  /**
   * Initialize configuration
   */
  public async initialize(): Promise<void> {
    try {
      // Ensure config directory exists
      try {
        await fs.access(this.configDir);
      } catch (error) {
        await fs.mkdir(this.configDir, { recursive: true });
        this.logger.info(`Created config directory: ${this.configDir}`);
      }
      
      // Load routes
      await this.loadRoutes();
      
      this.isInitialized = true;
      this.logger.info('Configuration manager initialized');
    } catch (error) {
      this.logger.error('Failed to initialize configuration manager', error);
      throw error;
    }
  }
  
  /**
   * Load routes from file or Redis
   */
  private async loadRoutes(): Promise<void> {
    try {
      // First try to load from Redis
      const redisRoutes = await this.loadRoutesFromRedis();
      
      if (redisRoutes.length > 0) {
        this.routes = redisRoutes;
        this.logger.info(`Loaded ${redisRoutes.length} routes from Redis`);
        return;
      }
      
      // Fall back to file system
      const routesFile = path.join(this.configDir, 'routes.json');
      
      try {
        const data = await fs.readFile(routesFile, 'utf8');
        this.routes = JSON.parse(data);
        this.logger.info(`Loaded ${this.routes.length} routes from file`);
        
        // Cache in Redis for next time
        await this.saveRoutesToRedis();
      } catch (error) {
        // If file doesn't exist, create with defaults
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          this.routes = this.getDefaultRoutes();
          await this.saveRoutes();
          this.logger.info(`Created default routes configuration`);
        } else {
          throw error;
        }
      }
    } catch (error) {
      this.logger.error('Failed to load routes', error);
      throw error;
    }
  }
  
  /**
   * Load routes from Redis
   */
  private async loadRoutesFromRedis(): Promise<RouteConfig[]> {
    try {
      const data = await this.redis.get('config:routes');
      
      if (data) {
        return JSON.parse(data);
      }
      
      return [];
    } catch (error) {
      this.logger.error('Failed to load routes from Redis', error);
      return [];
    }
  }
  
  /**
   * Save routes to Redis
   */
  private async saveRoutesToRedis(): Promise<void> {
    try {
      await this.redis.set('config:routes', JSON.stringify(this.routes));
    } catch (error) {
      this.logger.error('Failed to save routes to Redis', error);
    }
  }
  
  /**
   * Get default routes
   */
  private getDefaultRoutes(): RouteConfig[] {
    return [
      {
        name: 'example-service',
        pattern: '/api/example/:id',
        target: 'http://localhost:3001',
        methods: ['GET', 'POST', 'PUT', 'DELETE'],
        policies: ['authentication', 'rate-limiting'],
        circuitBreaker: {
          failureThreshold: 5,
          resetTimeout: 30000
        }
      }
    ];
  }
  
  /**
   * Get all routes
   */
  public async getRoutes(): Promise<RouteConfig[]> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    return this.routes;
  }
  
  /**
   * Add a new route
   */
  public async addRoute(route: RouteConfig): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    this.routes.push(route);
    await this.saveRoutes();
    
    this.logger.info(`Added route: ${route.name}`);
  }
  
  /**
   * Update a route
   */
  public async updateRoute(name: string, route: RouteConfig): Promise<boolean> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    const index = this.routes.findIndex(r => r.name === name);
    
    if (index === -1) {
      return false;
    }
    
    this.routes[index] = route;
    await this.saveRoutes();
    
    this.logger.info(`Updated route: ${name}`);
    return true;
  }
  
  /**
   * Delete a route
   */
  public async deleteRoute(name: string): Promise<boolean> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    const initialLength = this.routes.length;
    this.routes = this.routes.filter(r => r.name !== name);
    
    if (this.routes.length === initialLength) {
      return false;
    }
    
    await this.saveRoutes();
    
    this.logger.info(`Deleted route: ${name}`);
    return true;
  }
  
  /**
   * Save routes to file
   */
  private async saveRoutes(): Promise<void> {
    try {
      const routesFile = path.join(this.configDir, 'routes.json');
      await fs.writeFile(routesFile, JSON.stringify(this.routes, null, 2));
      
      // Also update Redis
      await this.saveRoutesToRedis();
    } catch (error) {
      this.logger.error('Failed to save routes', error);
      throw error;
    }
  }
}