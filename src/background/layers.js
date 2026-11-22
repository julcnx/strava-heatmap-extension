export const DEFAULT_LAYER_PRESETS = [
	{ activity: 'all', color: 'orange' },
	{ activity: 'ride', color: 'purple' },
	{ activity: 'run', color: 'sunset' },
	{ activity: 'water', color: 'blue' },
	{ activity: 'winter', color: 'highcontrast' },
];

export async function resetLayerPresets() {
	const layerPresets = await getLayerPresets();
	if (layerPresets.length > 0) return false;

	await setLayerPresets(DEFAULT_LAYER_PRESETS);

	console.log(
		'[StravaHeatmapExt] Initializing default layer presets',
		DEFAULT_LAYER_PRESETS
	);

	return true;
}

// Colors removed from Strava in favor of new palettes (v0.14.0)
const MIGRATED_COLORS = {
	hot: 'orange',
	gray: 'highcontrast',
};

export async function migrateLayerPresets() {
	const layerPresets = await getLayerPresets();
	if (!layerPresets.some(({ color }) => color in MIGRATED_COLORS)) return false;

	const migratedLayerPresets = layerPresets.map(({ activity, color }) => ({
		activity,
		color: MIGRATED_COLORS[color] ?? color,
	}));
	await setLayerPresets(migratedLayerPresets);

	console.log('[StravaHeatmapExt] Migrated layer presets', migratedLayerPresets);

	return true;
}

export async function setLayerPresets(layerPresets) {
	const layers = formatLayerPresets(layerPresets);

	await browser.storage.local.set({ layers });
}

export async function getLayerPresets() {
	const { layers } = await browser.storage.local.get('layers');
	if (typeof layers !== 'string') return [];

	const layerPresets = layers.split(';').map((item) => {
		const [activity, color] = item.split(':');
		return { activity, color };
	});

	return layerPresets;
}

export function formatLayerPresets(layerPresets) {
	return layerPresets.map(({ activity, color }) => `${activity}:${color}`).join(';');
}

export function validateLayerPresets(layerPresets) {
	for (const { activity, color } of layerPresets) {
		if (activity === undefined || color === undefined) {
			return false;
		}
	}
	return true;
}
