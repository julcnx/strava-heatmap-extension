// Available color schemes for the heatmap
const COLORS = {
  blue: ['🔵', 'Blue'],
  hot: ['🔥', 'Hot'],
  gray: ['⚪', 'Gray'],
  purple: ['🟣', 'Purple'],
  bluered: ['🔴', 'Blue-Red'],
  orange: ['🟠', 'Orange'],
};

const ACTIVITIES = {
  all: 'All Sports',
  run: 'All Foot Sports',
  sport_Run: 'Run',
  sport_TrailRun: 'Trail Run',
  sport_Walk: 'Walk',
  sport_Hike: 'Hike',
  ride: 'All Cycle Sports',
  sport_Ride: 'Ride',
  sport_MountainBikeRide: 'Mountain Bike Ride',
  sport_GravelRide: 'Gravel Ride',
  sport_EBikeRide: 'E-Bike Ride',
  sport_EMountainBikeRide: 'E-Mountain Bike Ride',
  sport_Velomobile: 'Velomobile',
  water: 'All Water Sports',
  sport_Canoeing: 'Canoe',
  sport_Kayaking: 'Kayaking',
  sport_Kitesurf: 'Kitesurf',
  sport_Rowing: 'Rowing',
  sport_Sail: 'Sail',
  sport_StandUpPaddling: 'Stand Up Paddling',
  sport_Surfing: 'Surfing',
  sport_Swim: 'Swim',
  sport_Windsurf: 'Windsurf',
  winter: 'All Winter Sports',
  sport_AlpineSki: 'Alpine Ski',
  sport_BackcountrySki: 'Backcountry Ski',
  sport_IceSkate: 'Ice Skate',
  sport_NordicSki: 'Nordic Ski',
  sport_Snowboard: 'Snowboard',
  sport_Snowshoe: 'Snowshoe',
};

const ACTIVITY_GROUPS = {
  'Top Categories': ['all', 'run', 'ride', 'water', 'winter'],
  'Foot Sports': ['sport_Run', 'sport_TrailRun', 'sport_Walk', 'sport_Hike'],
  'Cycle Sports': [
    'sport_Ride',
    'sport_MountainBikeRide',
    'sport_GravelRide',
    'sport_EBikeRide',
    'sport_EMountainBikeRide',
    'sport_Velomobile',
  ],
  'Water Sports': [
    'sport_Canoeing',
    'sport_Kayaking',
    'sport_Kitesurf',
    'sport_Rowing',
    'sport_Sail',
    'sport_StandUpPaddling',
    'sport_Surfing',
    'sport_Swim',
    'sport_Windsurf',
  ],
  'Winter Sports': [
    'sport_AlpineSki',
    'sport_BackcountrySki',
    'sport_IceSkate',
    'sport_NordicSki',
    'sport_Snowboard',
    'sport_Snowshoe',
  ],
};

export const COLOR_OPTIONS = Object.keys(COLORS).map((key) => [
  key,
  formatLayerColor(key),
]);

export const ACTIVITY_OPTIONS = Object.entries(ACTIVITY_GROUPS).map(([group, values]) => [
  group,
  values.map((value) => [value, ACTIVITIES[value]]),
]);

function formatLayerColor(value) {
  const [emoji, label] = COLORS[value] || ['❓', value];
  return `${emoji} ${label}`;
}

// Creates a layer configuration object
function getLayerConfig(
  position,
  activity,
  color,
  timestamp,
  authenticated,
  version,
  short
) {
  const activityName = ACTIVITIES[activity];
  const [colorEmoji] = COLORS[color] || '❓';

  return {
    id: `strava-heatmap-${activity}`,
    name: `${new Array(position).join('󠀠')}${colorEmoji} ${
      short ? activityName : `Strava Heatmap ${activityName}`
    }`,
    description: `Shows ${activityName.toLowerCase()} aggregated, public Strava activities over the last year in ${colorEmoji} color.`,
    template: authenticated
      ? `https://content-a.strava.com/identified/globalheat/${activity}/${color}/{z}/{x}/{y}.png?v=19&t=${timestamp}`
      : `https://raw.githubusercontent.com/julcnx/strava-heatmap-extension/refs/heads/v${version}/assets/heatmap-fallback.png?v=1&z={z}&x={x}&y={y}`,
    zoomExtent: authenticated ? [0, 15] : [0, 20],
  };
}

// Generates layer options with optional callback for extension
export function getLayerConfigs(layerPresets, authenticated, version, short = false) {
  const timestamp = Date.now().toString();

  return layerPresets.map(({ activity, color }, index) =>
    getLayerConfig(index + 1, activity, color, timestamp, authenticated, version, short)
  );
}

export function setupLayerPresetsChangeListener(callback) {
  window.addEventListener('message', (event) => {
    if (event.source !== window) return; // ignore messages from iframes
    if (event.data.type === 'layerPresetsChanged') {
      callback(event.data.payload);
    }
  });
}

export function parseLayerPresets(string) {
  return string.split(';').map((item) => {
    const [activity, color] = item.split(':');
    return { activity, color };
  });
}
