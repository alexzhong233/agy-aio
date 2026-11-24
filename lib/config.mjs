// Configuration schema and persistence for the bundled proxy.

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile, chownToRealUser, getPlatformInfo } from './platform.mjs';

const TARGET_PROCESSES = [
  'language_server_macos_arm',
  'language_server_macos_x64',
  'language_server_linux_x64',
  'language_server_linux_arm64',
  'language_server_windows_x64.exe',
  'language_server',
  'Antigravity',
  'Antigravity.exe',
  'Antigravity IDE',
  'Antigravity IDE.exe',
  'Antigravity Helper',
  'node',
  'agy',
  'agy.exe'
];

const PROXY_RULES = {
  allowed_ports: [80, 443],
  dns_mode: 'direct',
  ipv6_mode: 'proxy',
  routing: {
    default_action: 'proxy',
    rules: [
      {
        name: 'Bypass Localhost',
        enabled: true,
        action: 'direct',
        domains: ['localhost', '*.local', 'local'],
        ip_cidrs_v4: ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']
      },
      {
        name: 'Bypass Apple & CN',
        enabled: true,
        action: 'direct',
        domains: ['*.apple.com', '*.icloud.com', '*.cn']
      },
      {
        name: 'Proxy Google Services',
        enabled: true,
        action: 'proxy',
        domains: ['*.google.com', '*.googleapis.com', '*.gstatic.com', '*.googleusercontent.com']
      }
    ]
  }
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function getConfigPath(platformInfo = getPlatformInfo()) {
  return path.join(platformInfo.dataDir, 'config.json');
}

export function getDefaultConfig({ host = '127.0.0.1', port = 7890, type = 'socks5' } = {}) {
  return {
    proxy: { host, port, type },
    fake_ip: { enabled: true, cidr: '198.18.0.0/15' },
    timeout: { connect_ms: 5000, send_ms: 5000, recv_ms: 5000 },
    target_processes: [...TARGET_PROCESSES],
    child_injection: true,
    proxy_rules: clone(PROXY_RULES)
  };
}

function mergeDefaults(base, overrides) {
  if (!overrides || typeof overrides !== 'object') return base;
  return {
    ...base,
    ...overrides,
    proxy: { ...base.proxy, ...(overrides.proxy || {}) },
    fake_ip: { ...base.fake_ip, ...(overrides.fake_ip || {}) },
    timeout: { ...base.timeout, ...(overrides.timeout || {}) },
    target_processes: overrides.target_processes || base.target_processes,
    proxy_rules: overrides.proxy_rules || base.proxy_rules
  };
}

export function loadConfig(configPath = getConfigPath(), defaults = {}) {
  const base = mergeDefaults(getDefaultConfig(), defaults);
  let exists = false;

  if (!fs.existsSync(configPath)) {
    return { config: base, exists, path: configPath };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to parse config at ${configPath}: ${error.message}`);
  }

  exists = true;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid config at ${configPath}: expected a JSON object`);
  }

  const config = {
    ...base,
    ...parsed,
    proxy: { ...base.proxy, ...(parsed.proxy || {}) },
    fake_ip: { ...base.fake_ip, ...(parsed.fake_ip || {}) },
    timeout: { ...base.timeout, ...(parsed.timeout || {}) }
  };

  // Keep user customizations intact when the file already carries them.
  if (!parsed.target_processes) config.target_processes = base.target_processes;
  if (!parsed.proxy_rules) config.proxy_rules = base.proxy_rules;

  return { config, exists, path: configPath };
}

export function saveConfig(config, configPath = getConfigPath(), platformInfo = getPlatformInfo()) {
  const content = `${JSON.stringify(config, null, 2)}\n`;
  atomicWriteFile(configPath, content, { platformInfo });
  chownToRealUser(configPath, platformInfo);
  return configPath;
}

export function updateProxyEndpoint(config, { host, port, type } = {}) {
  const next = {
    ...config,
    proxy: { ...((config && config.proxy) || {}) }
  };

  if (host !== undefined) {
    if (typeof host !== 'string' || host.trim() === '') {
      throw new TypeError('proxy host must be a non-empty string');
    }
    next.proxy.host = host.trim();
  }

  if (port !== undefined) {
    const numeric = typeof port === 'string' ? Number(port) : port;
    if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65535) {
      throw new RangeError('proxy port must be an integer between 1 and 65535');
    }
    next.proxy.port = numeric;
  }

  if (type !== undefined) {
    if (type !== 'socks5' && type !== 'http') {
      throw new TypeError("proxy type must be either 'socks5' or 'http'");
    }
    next.proxy.type = type;
  }

  return next;
}

export function syncConfigToTarget(targetDir, config, { force = false, platformInfo = getPlatformInfo() } = {}) {
  const configPath = path.join(targetDir, 'config.json');
  if (!force && fs.existsSync(configPath)) {
    return { written: false, path: configPath };
  }

  saveConfig(config, configPath, platformInfo);
  return { written: true, path: configPath };
}
