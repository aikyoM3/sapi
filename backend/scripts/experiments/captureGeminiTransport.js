// Experiment-only diagnostics. Never change the request, parse tool calls as
// invoice data, or execute functions returned by a provider.
const { getGeminiEndpointSettings } = require('../../services/geminiClient');

function withTransportDiagnostics(extract) {
  return async (files, options) => {
    const originalFetch = global.fetch;
    const origin = new URL(getGeminiEndpointSettings().baseUrl).origin;
    const responses = [];
    global.fetch = async (...args) => {
      const response = await originalFetch(...args);
      let url;
      try { url = new URL(typeof args[0] === 'string' || args[0] instanceof URL ? String(args[0]) : args[0].url); }
      catch { return response; }
      if (url.origin === origin) {
        const entry = { http_status: response.status, url: url.origin + url.pathname, received_at: new Date().toISOString() };
        try {
          entry.raw_text = await response.clone().text();
          try { entry.body = JSON.parse(entry.raw_text); } catch { /* Preserve non-JSON provider errors verbatim. */ }
        } catch (error) { entry.capture_error = error.message; }
        responses.push(entry);
      }
      return response;
    };
    try { return await extract(files, options); }
    catch (error) {
      error.diagnostics = { ...error.diagnostics, transport_responses: responses };
      throw error;
    } finally { global.fetch = originalFetch; }
  };
}

module.exports = { withTransportDiagnostics };
