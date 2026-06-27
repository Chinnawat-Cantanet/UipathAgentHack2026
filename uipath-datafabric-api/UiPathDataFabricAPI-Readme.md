# UiPath Data Fabric API

## Overview

This project provides a lightweight Node.js API that securely accesses UiPath Data Fabric.

It acts as an intermediary between external applications (such as Claude Desktop, MCP servers, or web dashboards) and the UiPath Data Fabric REST API. The API handles OAuth authentication, retrieves transcript data, and returns the results in a simplified JSON format.

---

## Prerequisites

* Node.js (v20 or later recommended)
* npm
* ngrok
* UiPath Automation Cloud account
* Access to the target Data Fabric dataset

---

## Installation

Install project dependencies:

```bash
npm install
```

---

## Environment Configuration

Create a `.env` file in the project root and configure the required values.

Example:

```env
# Paste your Client Secret from Postman / UiPath Admin > External Apps here.
# This is the only secret value — never commit this file or share it.

PORT=

UIPATH_CLIENT_ID=
UIPATH_CLIENT_SECRET=""

UIPATH_TOKEN_URL=

UIPATH_SCOPE=DataFabric.Data.Read DataFabric.Schema.Read

UIPATH_BASE_DATA_URL=

PAGE_SIZE=1000
```

> Do not commit the `.env` file to source control.

---

## Running the API

Start the server:

```bash
npm start
```

The API will run locally on:

```
http://localhost:3000
```

---

## Expose the API (Optional)

If external services (such as Claude Desktop or an MCP server) need to access your local API, expose it using ngrok.

Authenticate ngrok (first-time setup only):

```bash
ngrok config add-authtoken YOUR_NGROK_AUTHTOKEN
```

Create a public tunnel:

```bash
ngrok http 3000
```

Use the generated HTTPS URL when configuring your external client.

---

## Project Structure

```
uipath-datafabric-api/
│
├── public/
├── server.js
├── package.json
├── package-lock.json
├── .env
└── README.md
```

---

## Purpose

This API is intended to:

* Authenticate with UiPath Automation Cloud
* Retrieve transcript data from UiPath Data Fabric
* Provide a simple REST endpoint for AI applications
* Keep UiPath credentials secure by storing them server-side
