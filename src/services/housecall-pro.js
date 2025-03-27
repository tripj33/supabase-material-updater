import axios from 'axios';
import { logger } from '../utils/logger.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Housecall Pro API configuration
const HCP_API_KEY = process.env.HCP_API_KEY;
const HCP_API_BASE_URL = 'https://api.housecallpro.com/api';

if (!HCP_API_KEY) {
  logger.error('Housecall Pro API key is missing in environment variables');
  process.exit(1);
}

/**
 * Service for interacting with Housecall Pro API
 */
class HousecallProService {
  constructor() {
    this.axiosInstance = axios.create({
      baseURL: HCP_API_BASE_URL,
      headers: {
        'Authorization': `Bearer ${HCP_API_KEY}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });
  }

  /**
   * Get all material categories from Housecall Pro
   * @param {Object} options - Options for fetching categories
   * @param {string} [options.parentUuid] - UUID of parent category
   * @param {number} [options.pageSize=200] - Number of categories per page
   * @returns {Promise<Array>} Array of material categories
   */
  async getMaterialCategories(options = {}) {
    try {
      const { parentUuid, pageSize = 200 } = options;
      
      const params = {
        page_size: pageSize
      };
      
      if (parentUuid) {
        params.parent_uuid = parentUuid;
      }
      
      logger.info(`Fetching material categories from Housecall Pro${parentUuid ? ` under parent ${parentUuid}` : ''}`);
      
      const response = await this.axiosInstance.get('/price_book/material_categories', { params });
      
      logger.info(`Fetched ${response.data.data.length} material categories from Housecall Pro`);
      return response.data.data;
    } catch (error) {
      logger.error(`Error fetching material categories from Housecall Pro: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get materials for a specific category from Housecall Pro
   * @param {string} categoryUuid - UUID of the category
   * @param {number} [pageSize=200] - Number of materials per page
   * @param {number} [page=1] - Page number
   * @returns {Promise<Array>} Array of materials
   */
  async getMaterialsByCategory(categoryUuid, pageSize = 200, page = 1) {
    try {
      logger.info(`Fetching materials for category ${categoryUuid} from Housecall Pro (page ${page})`);
      
      const params = {
        material_category_uuid: categoryUuid,
        page_size: pageSize,
        page: page
      };
      
      const response = await this.axiosInstance.get('/price_book/materials', { params });
      
      logger.info(`Fetched ${response.data.data.length} materials for category ${categoryUuid} (page ${page})`);
      return response.data.data;
    } catch (error) {
      logger.error(`Error fetching materials for category ${categoryUuid}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Update a material in Housecall Pro
   * @param {string} uuid - UUID of the material to update
   * @param {Object} data - Data to update
   * @returns {Promise<Object>} Updated material
   */
  async updateMaterial(uuid, data) {
    try {
      logger.info(`Updating material ${uuid} in Housecall Pro`);
      
      const response = await this.axiosInstance.put(`/price_book/materials/${uuid}`, data);
      
      logger.info(`Successfully updated material ${uuid} in Housecall Pro`);
      return response.data;
    } catch (error) {
      logger.error(`Error updating material ${uuid} in Housecall Pro: ${error.message}`);
      throw error;
    }
  }
}

export default new HousecallProService();
