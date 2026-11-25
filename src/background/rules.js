export async function updateHeatmapRules(credentials) {
  const condition = {
    regexFilter:
      '^https://[^/]+\\.strava\\.com/identified/globalheat/[^/]+/[^/]+/[^/]+/[^/]+/[^/]+\\.png',
    resourceTypes: ['image', 'xmlhttprequest'],
    excludedInitiatorDomains: ['strava.com'],
  };

  const rule = {
    id: 1,
    priority: 1,
    condition,
    action: {
      type: 'modifyHeaders',
      requestHeaders: credentials
        ? [
            {
              header: 'Cookie',
              operation: 'set',
              value: credentials,
            },
          ]
        : undefined,
      responseHeaders: [
        {
          header: 'Access-Control-Allow-Origin',
          operation: 'set',
          value: '*',
        },
      ],
    },
  };

  await browser.declarativeNetRequest.updateDynamicRules(
    {
      removeRuleIds: Array.from({ length: 10 }, (_, i) => i + 1),
      addRules: [rule],
    },
    () => {
      if (browser.runtime.lastError) {
        console.error(
          '[StravaHeatmapExt] Failed to remove heatmap rule.',
          browser.runtime.lastError
        );
      } else {
        console.log(
          '[StravaHeatmapExt] Added heatmap rule.',
          rule.id,
          Boolean(credentials)
        );
      }
    }
  );

  return [rule];
}
