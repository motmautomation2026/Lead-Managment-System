/**
 * Runs `open` once the menu has closed and handed focus back: a dialog opened straight from a
 * Radix menu item fights the menu's focus return (focus ping-pong).
 */
export const afterMenuClose = (open: () => void) => () => void window.setTimeout(open, 0);
