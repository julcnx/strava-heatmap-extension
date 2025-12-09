import { getExtensionName } from '../extension.js';

export async function showNotification(options) {
  const {
    message,
    iconGray = false,
    autoClose = true,
    autoCloseDelay = 5000,
    buttons = [],
    onClick = null,
  } = options;

  const iconUrl = iconGray ? '/icons/icon-128-grayscale.png' : '/icons/icon-128.png';

  const notificationOptions = {
    type: 'basic',
    iconUrl,
    title: getExtensionName(),
    message,
  };

  // Firefox doesn't support requireInteraction, so we skip it entirely
  // Chrome supports it, but we'll rely on autoClose behavior instead
  // This keeps notifications consistent across browsers

  // Only add buttons if provided (not supported in all browsers)
  if (buttons.length > 0) {
    notificationOptions.buttons = buttons;
  }

  const notificationId = await browser.notifications.create(notificationOptions);

  // Set up button click listener if callback provided
  if (onClick) {
    const listener = (clickedNotificationId) => {
      if (clickedNotificationId === notificationId) {
        onClick();
        browser.notifications.clear(clickedNotificationId);
        browser.notifications.onClicked.removeListener(listener);
      }
    };
    browser.notifications.onClicked.addListener(listener);
  }

  if (autoClose) {
    setTimeout(() => {
      browser.notifications.clear(notificationId);
    }, autoCloseDelay);
  }

  return notificationId;
}
