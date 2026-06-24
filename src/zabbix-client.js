import { config } from './config.js';
import { log } from './logger.js';

const API_PATH = '/api_jsonrpc.php';

async function fetchWithTimeout(url, options = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), config.timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

export class ZabbixClient {
  constructor() {
    this.url = `${config.zabbix.url}${API_PATH}`;
    this.token = config.zabbix.token;
    this.id = 1;
  }

  async call(method, params = {}) {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
      id: this.id++,
    });
    log.debug(`Zabbix POST ${method}`);
    const headers = {
      'Content-Type': 'application/json-rpc',
      'User-Agent': config.userAgent,
      Authorization: `Bearer ${this.token}`,
    };
    const res = await fetchWithTimeout(this.url, {
      method: 'POST',
      headers,
      body,
    });
    if (!res.ok) {
      throw new Error(`Zabbix HTTP ${res.status} ${res.statusText} on ${method}`);
    }
    const json = await res.json();
    if (json.error) {
      const e = json.error;
      throw new Error(
        `Zabbix API error: ${e.message} — ${e.data ?? ''} (code ${e.code})`,
      );
    }
    return json.result;
  }
}
