/**
 * Terminal color themes for xterm.js
 * Each theme provides: background, foreground, cursor, selection, and ANSI colors 0-15.
 */

export const terminalThemes = {
    'Default Dark': {
        background: '#1e1e20', foreground: '#d4d4d4', cursor: 'transparent',
        selectionBackground: '#264f78',
        black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510',
        blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
        brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543',
        brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#e5e5e5',
    },
    'Adventure': {
        background: '#040404', foreground: '#feffff', cursor: '#feffff',
        selectionBackground: '#606060',
        black: '#040404', red: '#d84a33', green: '#5da602', yellow: '#eebb6e',
        blue: '#417ab3', magenta: '#e5c499', cyan: '#bdcfe5', white: '#dbded8',
        brightBlack: '#685656', brightRed: '#d76b42', brightGreen: '#99b52c', brightYellow: '#ffb670',
        brightBlue: '#97d7ef', brightMagenta: '#aa7900', brightCyan: '#bdcfe5', brightWhite: '#e4d5c7',
    },
    'Dracula': {
        background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2',
        selectionBackground: '#44475a',
        black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
        blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
        brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5',
        brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
    },
    'Nord': {
        background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9',
        selectionBackground: '#434c5e',
        black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b',
        blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
        brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b',
        brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
    },
    'One Dark': {
        background: '#282c34', foreground: '#abb2bf', cursor: '#528bff',
        selectionBackground: '#3e4451',
        black: '#282c34', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
        blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
        brightBlack: '#545862', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b',
        brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#c8ccd4',
    },
    'Tokyo Night': {
        background: '#1a1b26', foreground: '#a9b1d6', cursor: '#c0caf5',
        selectionBackground: '#33467c',
        black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
        blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
        brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68',
        brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#c0caf5',
    },
    'Gruvbox Dark': {
        background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2',
        selectionBackground: '#504945',
        black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921',
        blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
        brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f',
        brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
    },
    'Monokai': {
        background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f0',
        selectionBackground: '#49483e',
        black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75',
        blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4', white: '#f8f8f2',
        brightBlack: '#75715e', brightRed: '#f92672', brightGreen: '#a6e22e', brightYellow: '#f4bf75',
        brightBlue: '#66d9ef', brightMagenta: '#ae81ff', brightCyan: '#a1efe4', brightWhite: '#f9f8f5',
    },
    'Solarized Dark': {
        background: '#002b36', foreground: '#839496', cursor: '#839496',
        selectionBackground: '#073642',
        black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
        blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
        brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83',
        brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
};

/** All registered terminal theme change listeners. */
const _listeners = new Set();

/** Register a callback to be notified when the terminal theme changes. */
export function onTerminalThemeChange(callback) {
    _listeners.add(callback);
    return () => _listeners.delete(callback);
}

/** Get the current terminal theme object. */
export function getTerminalTheme() {
    const name = localStorage.getItem('notebook-terminal-theme') || 'Adventure';
    return terminalThemes[name] || terminalThemes['Default Dark'];
}

/** Set the terminal theme by name and notify all listeners. */
export function setTerminalTheme(name) {
    const theme = terminalThemes[name] || terminalThemes['Default Dark'];
    localStorage.setItem('notebook-terminal-theme', name);
    for (const cb of _listeners) cb(theme, name);
}
