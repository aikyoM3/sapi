const os = require('os');

function isPrivateIpv4(address) {
  const parts = String(address || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function interfacePriority(name) {
  const normalized = String(name || '').toLowerCase();
  if (/(vpn|virtual|vbox|vmware|hyper-v|vethernet|wsl|docker|tunnel|loopback|tap)/.test(normalized)) return 0;
  if (/^(wi-?fi|wlan|ethernet|eth\d*|en\d*)/.test(normalized)) return 2;
  return 1;
}

function getLocalLanIp(options = {}) {
  const override = String(options.override ?? process.env.LAN_IP ?? '').trim();
  if (override) {
    if (!isPrivateIpv4(override)) {
      throw Object.assign(new Error('LAN_IP phải là địa chỉ IPv4 private hợp lệ.'), { statusCode: 400 });
    }
    return override;
  }

  const interfaces = options.interfaces || os.networkInterfaces();
  const candidates = Object.entries(interfaces).flatMap(([name, addresses]) =>
    (addresses || [])
      .filter((item) => (item.family === 'IPv4' || item.family === 4) && !item.internal && isPrivateIpv4(item.address))
      .map((item) => ({ address: item.address, priority: interfacePriority(name) })),
  );
  candidates.sort((left, right) => right.priority - left.priority);

  if (!candidates[0]) {
    throw Object.assign(new Error('Không xác định được địa chỉ IP LAN. Hãy cấu hình LAN_IP trong .env.'), { statusCode: 400 });
  }
  return candidates[0].address;
}

function getMobileBaseUrl(options = {}) {
  const port = Number(options.port ?? process.env.PORT) || 3000;
  return `http://${getLocalLanIp(options)}:${port}`;
}

module.exports = { getLocalLanIp, getMobileBaseUrl, isPrivateIpv4 };
