import { logger } from './logger.js';

/**
 * Task Queue for managing parallel processing with controlled concurrency
 */
export class TaskQueue {
  constructor(options = {}) {
    this.concurrency = options.concurrency || 3;
    this.running = 0;
    this.queue = [];
    this.results = [];
    this.onComplete = options.onComplete || null;
  }

  /**
   * Add a task to the queue
   * @param {Function} task - Task function that returns a Promise
   * @param {Object} options - Task options
   * @param {string} options.taskName - Name of the task for logging
   * @param {number} options.priority - Priority of the task (higher runs first)
   * @returns {Promise<any>} Promise that resolves with the task result
   */
  add(task, { taskName = 'unnamed task', priority = 0 } = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        task,
        taskName,
        priority,
        resolve,
        reject
      });
      
      logger.debug(`Added task to queue: ${taskName} (priority: ${priority}, queue size: ${this.queue.length})`);
      
      this.runNext();
    });
  }

  /**
   * Run the next task in the queue if concurrency allows
   */
  runNext() {
    if (this.running >= this.concurrency || this.queue.length === 0) {
      return;
    }
    
    // Sort queue by priority (higher first)
    this.queue.sort((a, b) => b.priority - a.priority);
    
    const { task, taskName, resolve, reject } = this.queue.shift();
    
    this.running++;
    logger.debug(`Starting task: ${taskName} (running: ${this.running}, queued: ${this.queue.length})`);
    
    const startTime = Date.now();
    
    Promise.resolve()
      .then(() => task())
      .then(result => {
        const duration = Date.now() - startTime;
        logger.debug(`Completed task: ${taskName} in ${duration}ms`);
        
        this.results.push({
          taskName,
          success: true,
          result,
          duration
        });
        
        resolve(result);
      })
      .catch(error => {
        const duration = Date.now() - startTime;
        logger.error(`Task failed: ${taskName} after ${duration}ms - ${error.message}`);
        
        this.results.push({
          taskName,
          success: false,
          error: error.message,
          duration
        });
        
        reject(error);
      })
      .finally(() => {
        this.running--;
        this.runNext();
        
        // If queue is empty and nothing is running, call onComplete callback
        if (this.queue.length === 0 && this.running === 0 && this.onComplete) {
          this.onComplete(this.results);
        }
      });
    
    // If we can run more tasks, do so
    if (this.running < this.concurrency) {
      this.runNext();
    }
  }

  /**
   * Wait for all tasks to complete
   * @returns {Promise<Array>} Promise that resolves with all task results
   */
  async waitForAll() {
    if (this.queue.length === 0 && this.running === 0) {
      return this.results;
    }
    
    return new Promise(resolve => {
      this.onComplete = () => {
        resolve(this.results);
      };
    });
  }
  
  /**
   * Get the current status of the task queue
   * @returns {Object} Status information
   */
  getStatus() {
    return {
      queueLength: this.queue.length,
      running: this.running,
      completed: this.results.length,
      concurrency: this.concurrency
    };
  }
}

export default TaskQueue;