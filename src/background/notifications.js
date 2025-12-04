export async function showNotification(options) {
  const {
    message,
    iconGray = false,
    autoClose = true,
    autoCloseDelay = 5000,
    buttons = [],
    onClick = null,
    requireInteraction = false,
  } = options;

  const iconUrl = iconGray ? '/icons/icon-128-grayscale.png' : '/icons/icon-128.png';

  const notificationOptions = {
    type: 'basic',
    iconUrl,
    title: 'Strava Heatmap',
    message,
    requireInteraction,
  };

  // Only add buttons if provided (not supported in all browsers)
  if (buttons.length > 0) {
    notificationOptions.buttons = buttons;
  }

  const notificationId = await browser.notifications.create(notificationOptions);

  // Set up button click listener if callback provided
  if (onClick) {
    const listener = (clickedNotificationId, buttonIndex) => {
      if (clickedNotificationId === notificationId) {
        onClick(buttonIndex);
        browser.notifications.onButtonClicked.removeListener(listener);
      }
    };
    browser.notifications.onButtonClicked.addListener(listener);
  }

  if (autoClose) {
    setTimeout(() => {
      browser.notifications.clear(notificationId);
    }, autoCloseDelay);
  }

  return notificationId;
}
