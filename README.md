# Supabase Material Price Updater

A tool to automatically update material prices in a Supabase database by scraping vendor websites and sync with Housecall Pro.

## Overview

This tool automates the process of updating material prices in your inventory database by:

1. Fetching material items and their associated vendor sources from Supabase
2. Using Puppeteer to navigate to vendor websites and take screenshots of product pages
3. Sending screenshots to the Gemini 2.0 API to extract pricing information
4. Updating the database with the new pricing information
5. Tracking outdated URLs and significant price changes

## Features

- **Vendor-specific handling**: Special handling for WinSupply and other vendor websites
- **Session optimization**: Maintains browser sessions for each vendor domain to minimize login operations
- **Price change detection**: Logs significant price changes (configurable threshold)
- **Outdated URL tracking**: Marks URLs as outdated when prices cannot be extracted
- **Comprehensive logging**: Detailed logs for debugging and monitoring
- **Price formatting**: All prices are rounded to two decimal places for consistency

## Prerequisites

- Node.js (v14 or higher)
- Supabase account with a database containing the required tables
- Gemini 2.0 API key
- Vendor credentials (if required, e.g., WinSupply)

## Installation

1. Clone the repository
2. Install dependencies:

```bash
npm install
```

3. Create a `.env` file with the following variables:

```
# Supabase credentials
SUPABASE_URL=your_supabase_url
SUPABASE_KEY=your_supabase_key

# Gemini API key
GEMINI_API_KEY=your_gemini_api_key

# WinSupply credentials
WINSUPPLY_EMAIL=your_winsupply_email
WINSUPPLY_PASSWORD=your_winsupply_password

# Price change threshold (percentage)
PRICE_CHANGE_THRESHOLD=30
```

## Database Structure

The tool expects the following tables in your Supabase database:

### material_items

- `id`: UUID (primary key)
- `name`: Text (material name)
- `cost`: Numeric (current cost)
- `sale_price`: Numeric (sale price)
- `cheapest_vendor_id`: UUID (reference to sources.id)
- `notes`: Text (notes with vendor information and timestamp)

### item_sources

- `id`: UUID (primary key)
- `item_id`: UUID (reference to material_items.id)
- `source_id`: UUID (reference to sources.id)
- `url`: Text (vendor product URL)
- `sale_price`: Numeric (vendor's sale price)
- `price_with_tax`: Numeric (sale price with tax)
- `out_of_date_url`: Boolean (flag for outdated URLs)

### sources

- `id`: UUID (primary key)
- `name`: Text (vendor name)

## Usage

### API Server

The API server provides endpoints for n8n integration and other automation tools:

```bash
npm run api
```

This will start an Express server on port 3001 (configurable via PORT environment variable) with the following endpoints:

#### Health Check
- `GET /api/health`: Check if the API server is running

#### Scraper Endpoints
- `POST /api/scraper/initialize`: Initialize the Puppeteer browser
- `POST /api/scraper/close`: Close the Puppeteer browser
- `POST /api/scraper/login`: Login to all vendor websites
- `POST /api/scraper/material/:materialId`: Scrape prices for a specific material item
- `POST /api/scraper/materials`: Scrape prices for all material items (with optional limit)

#### Housecall Pro Endpoints
- `POST /api/hcp/material/:uuid`: Update a specific Housecall Pro material
- `POST /api/hcp/materials`: Update all Housecall Pro materials (with optional limit and category filter)

### Price Scraper

Run the price scraper directly with:

```bash
npm run scrape
```

For testing purposes, you can limit the number of material items processed:

```bash
npm run scrape -- --limit 5
```

This will process only the first 5 material items, which is useful for testing before running on the full inventory.

You can also process a specific material item by ID:

```bash
npm run scrape -- --material-item-id your-material-id
```

### Material Price Updater (Legacy)

Run the legacy material price updater with:

```bash
npm start
```

For testing purposes, you can limit the number of material items processed:

```bash
npm start -- --limit 5
```

This will process only the first 5 material items, which is useful for testing before running on the full inventory.

### Housecall Pro Updater

To update Housecall Pro materials with prices from your Supabase database:

```bash
npm run update-hcp
```

This will:
1. Fetch all material categories from Housecall Pro
2. For each category, fetch all materials
3. Match materials with Supabase items by SKU/part number
4. Update Housecall Pro material costs with the sale prices from Supabase
5. Optionally update material images if they're missing in Housecall Pro

The Housecall Pro updater requires the following environment variable:

```
# Housecall Pro API key
HCP_API_KEY=your_housecall_pro_api_key
```

#### Testing Options

The Housecall Pro updater supports several command-line flags for testing:

```bash
# Limit to processing only 2 categories
npm run update-hcp -- --limit 2

# Run in dry-run mode (no actual updates)
npm run update-hcp -- --dry-run

# Process only a specific category by UUID
npm run update-hcp -- --category pbmcat_bfdf3660ba394327b13d09f5882f70d3

# Combine options
npm run update-hcp -- --dry-run --category pbmcat_bfdf3660ba394327b13d09f5882f70d3
```

These options are useful for testing the updater before running it on your entire inventory.

### Service/Contractor Item Finder

There are two implementations of the Service/Contractor Item Finder:

#### Standard Implementation

```bash
npm run find-service-contractor
```

This will:
1. Fetch all material categories from Housecall Pro
2. For each category, fetch all materials
3. Filter materials with names starting with "Service: " or "Contractor: "
4. Save the results to a JSON file (default: service-contractor-items.json)

You can specify a custom output file:

```bash
npm run find-service-contractor -- --output custom-output.json
```

#### Direct API Implementation

For more comprehensive results, use the direct API implementation:

```bash
npm run find-service-contractor-direct
```

This implementation:
1. Makes direct API calls to Housecall Pro
2. Fetches all material categories (up to 2000)
3. For each category, fetches all materials with proper pagination
4. Filters materials with names starting with "Service: " or "Contractor: "
5. Saves the results to a JSON file (default: service-contractor-items-direct.json)

You can specify a custom output file:

```bash
npm run find-service-contractor-direct -- --output custom-output.json
```

The output JSON files contain:
- Total count of matching items
- Service items (count and full details)
- Contractor items (count and full details)
- All matching items combined
- All categories (direct API implementation only)

## Testing

A test script is included to verify the functionality without making actual web requests or database changes:

```bash
node test.js
```

This script uses mock data and services to simulate the entire process, including:
- Fetching material items and item sources
- Taking screenshots of product pages
- Extracting prices from screenshots
- Updating item sources and material items
- Handling error cases

The test script is useful for verifying that the core logic works correctly before running the actual tool.

The tool will:

1. Fetch all material items from the database
2. For each material item, fetch its item sources
3. Group item sources by vendor domain
4. Process each vendor group, taking screenshots and extracting prices
5. Update the database with the new pricing information
6. Clean up temporary files

## Logs

Logs are stored in the `logs` directory:

- `combined.log`: All log messages
- `error.log`: Error messages only
- `price-changes.log`: Significant price changes
- `outdated-urls.log`: URLs marked as outdated

## Screenshots

Screenshots are temporarily stored in the `screenshots` directory and are automatically deleted after processing.

## License

ISC
