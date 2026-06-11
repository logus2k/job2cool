/**
 * File icon mapping — maps file extensions to SVG icon names.
 * Icons are served from static/vendor/icons/{name}.svg
 * Source: vscode-icons (CC BY 4.0) — https://github.com/vscode-icons/vscode-icons
 */

const ICON_BASE = 'static/vendor/icons/';
const ICON_LIGHT = 'static/vendor/icons/light/';

/** Icon keys that have a light-theme variant in icons/light/. */
const LIGHT_ICONS = new Set([
    'astro', 'babel', 'circleci', 'codeowners', 'config', 'cypress',
    'font', 'json', 'latex', 'next', 'nim', 'prettier',
    'prisma', 'rust', 'stylus', 'todo', 'toml', 'vite', 'yaml',
]);

/** Current theme — 'light' or 'dark'. */
let _theme = 'light';

/** Special full-filename matches (checked before extension). */
const NAME_MAP = {
    'dockerfile':        'dockerfile',
    'makefile':          'makefile',
    'cmakelists.txt':    'cmake',
    '.env':              'env',
    '.env.local':        'env',
    '.env.production':   'env',
    '.env.development':  'env',
    '.env.test':         'env',
    'license':           'license',
    'license.md':        'license',
    'license.txt':       'license',
    'readme.md':         'readme',
    'readme.txt':        'readme',
    'readme':            'readme',
    'changelog.md':      'changelog',
    'changelog':         'changelog',
    'contributing.md':   'contributing',
    'contributing':      'contributing',
    'todo.md':           'todo',
    'todo.txt':          'todo',
    'todo':              'todo',
    'codeowners':        'codeowners',
    'requirements.txt':  'pip',
    'setup.py':          'pip',
    'setup.cfg':         'pip',
    'pipfile':           'pip',
    'pyproject.toml':    'pip',
    'package.json':      'npm',
    'package-lock.json': 'npm',
    'yarn.lock':         'yarn',
    '.yarnrc':           'yarn',
    'nginx.conf':        'nginx',
    '.gitignore':        'git',
    '.gitattributes':    'git',
    '.gitmodules':       'git',
    '.dvcignore':        'dvc',
    '.dvclock':          'dvc',
    'tsconfig.json':     'tsconfig',
    'jsconfig.json':     'tsconfig',
    '.babelrc':          'babel',
    'babel.config.js':   'babel',
    '.eslintrc':         'eslint',
    '.eslintrc.js':      'eslint',
    '.eslintrc.json':    'eslint',
    'eslint.config.js':  'eslint',
    '.prettierrc':       'prettier',
    '.prettierrc.js':    'prettier',
    'prettier.config.js':'prettier',
    '.editorconfig':     'editorconfig',
    'webpack.config.js': 'webpack',
    'vite.config.js':    'vite',
    'vite.config.ts':    'vite',
    'rollup.config.js':  'rollup',
    'jest.config.js':    'jest',
    'jest.config.ts':    'jest',
    'cypress.config.js': 'cypress',
    'cypress.config.ts': 'cypress',
    'tailwind.config.js':'tailwind',
    'tailwind.config.ts':'tailwind',
    'postcss.config.js': 'postcss',
    '.gitlab-ci.yml':    'gitlab',
    'jenkinsfile':       'jenkins',
    'vagrantfile':       'vagrant',
};

/** Extension-based mapping. */
const EXT_MAP = {
    // Notebooks & data science
    'py': 'python_color', 'pyi': 'python_color', 'pyx': 'python_color',
    'ipynb': 'notebook', 'r': 'r_color', 'rmd': 'r_color', 'qmd': 'r_color', 'jl': 'julia',
    'm': 'matlab', 'mat': 'matlab',
    // Documents
    'pdf': 'pdf', 'md': 'markdown', 'txt': 'text', 'rst': 'text',
    'tex': 'latex', 'bib': 'latex', 'log': 'log',
    // Data formats
    'csv': 'csv', 'tsv': 'csv',
    'json': 'json', 'jsonc': 'json', 'json5': 'json',
    'xml': 'xml', 'xsl': 'xml', 'xslt': 'xml', 'xsd': 'xml',
    'graphql': 'graphql', 'gql': 'graphql',
    'yaml': 'yaml', 'yml': 'yaml', 'toml': 'toml',
    'cfg': 'config', 'ini': 'config', 'conf': 'config', 'properties': 'config',
    'proto': 'protobuf',
    'sql': 'sql', 'sqlite': 'sqlite', 'db': 'sqlite',
    'prisma': 'prisma', 'plist': 'plist',
    // Web
    'html': 'html', 'htm': 'html', 'xhtml': 'html',
    'ejs': 'ejs', 'pug': 'pug', 'jade': 'pug',
    'hbs': 'handlebars', 'handlebars': 'handlebars',
    'css': 'css', 'scss': 'scss', 'sass': 'sass', 'less': 'less',
    'styl': 'stylus',
    'js': 'javascript_color', 'jsx': 'react', 'mjs': 'javascript_color', 'cjs': 'javascript_color',
    'ts': 'typescript', 'tsx': 'react', 'mts': 'typescript',
    'vue': 'vue', 'svelte': 'svelte',
    'wasm': 'wasm', 'wat': 'wasm',
    // Shell & scripting
    'sh': 'shell', 'bash': 'shell', 'zsh': 'shell', 'fish': 'shell',
    'ps1': 'powershell', 'psm1': 'powershell', 'psd1': 'powershell',
    'bat': 'bat', 'cmd': 'bat',
    'lua': 'lua', 'pl': 'perl', 'pm': 'perl', 'rb': 'ruby',
    'php': 'php',
    // Compiled languages
    'c': 'c', 'h': 'c',
    'cpp': 'cpp', 'cc': 'cpp', 'cxx': 'cpp', 'hpp': 'cpp', 'hxx': 'cpp',
    'cs': 'csharp', 'csx': 'csharp',
    'java': 'java', 'jar': 'java',
    'kt': 'kotlin', 'kts': 'kotlin',
    'scala': 'scala', 'sc': 'scala',
    'go': 'go',
    'rs': 'rust',
    'swift': 'swift',
    'hs': 'haskell', 'lhs': 'haskell',
    'cu': 'cuda', 'cuh': 'cuda',
    'dart': 'dart',
    'ex': 'elixir', 'exs': 'elixir',
    'erl': 'erlang', 'hrl': 'erlang',
    'clj': 'clojure', 'cljs': 'clojure', 'cljc': 'clojure', 'edn': 'clojure',
    'fs': 'fsharp', 'fsi': 'fsharp', 'fsx': 'fsharp',
    'ml': 'ocaml', 'mli': 'ocaml',
    'zig': 'zig',
    'nim': 'nim',
    'asm': 'assembly', 's': 'assembly',
    'mm': 'objectivecpp',
    'groovy': 'groovy', 'gradle': 'groovy',
    'f90': 'fortran', 'f95': 'fortran', 'f03': 'fortran',
    'cob': 'cobol', 'cbl': 'cobol',
    'vb': 'vb', 'vbs': 'vb',
    // Infrastructure
    'tf': 'terraform', 'tfvars': 'terraform',
    // Images
    'png': 'image', 'jpg': 'image', 'jpeg': 'image',
    'gif': 'image', 'webp': 'image', 'bmp': 'image', 'ico': 'image',
    'svg': 'svg',
    // Media
    'mp3': 'audio', 'wav': 'audio', 'ogg': 'audio', 'flac': 'audio', 'aac': 'audio',
    'mp4': 'video', 'avi': 'video', 'mkv': 'video', 'mov': 'video', 'webm': 'video',
    // Fonts
    'ttf': 'font', 'otf': 'font', 'woff': 'font', 'woff2': 'font', 'eot': 'font',
    // Archives
    'zip': 'zip', 'tar': 'zip', 'gz': 'zip', 'bz2': 'zip', 'xz': 'zip',
    '7z': 'zip', 'rar': 'zip', 'whl': 'zip', 'egg': 'zip',
    // Security
    'pem': 'cert', 'crt': 'cert', 'cer': 'cert', 'ca-bundle': 'cert',
    'key': 'key', 'p12': 'key', 'pfx': 'key',
    // Binary
    'bin': 'binary', 'so': 'binary', 'dll': 'binary', 'dylib': 'binary',
    'o': 'binary', 'a': 'binary', 'pyc': 'binary', 'pyo': 'binary',
    'exe': 'binary',
    // DVC
    'dvc': 'dvc',
    // Env
    'env': 'env',
};

/** Resolve SVG path for an icon key, using light variant if available. */
function _resolve(key) {
    if (_theme === 'light' && LIGHT_ICONS.has(key)) {
        return ICON_LIGHT + key + '.svg';
    }
    return ICON_BASE + key + '.svg';
}

/** Per-extension icon override for KB document leaf nodes (Knowledge
 *  Base → Documents tree). PDF / Word / HTML use bespoke SVGs in
 *  frontend/images/ (served at /static/images/); Markdown uses the
 *  FontAwesome brand mark — Wunderbaum accepts an FA class string in
 *  the `icon` field. Anything else falls through to the vendor
 *  vscode-icons set. */
export function kbDocIconForFile(filename) {
    const name = (filename || '').split('/').pop().toLowerCase();
    const ext = name.includes('.') ? name.split('.').pop() : '';
    if (ext === 'pdf') return 'static/images/file-type-pdf2.svg';
    if (ext === 'md' || ext === 'markdown') return 'fa-brands fa-markdown';
    if (ext === 'doc' || ext === 'docx') return 'static/images/microsoft-word.svg';
    if (ext === 'html' || ext === 'htm') return 'static/images/html-5.svg';
    return iconPathForFile(filename);
}

/** Return the SVG path for a given filename. */
export function iconPathForFile(filename) {
    const name = filename.split('/').pop();
    const lower = name.toLowerCase();
    // Check full filename first (e.g. Dockerfile, .gitignore)
    if (NAME_MAP[lower]) return _resolve(NAME_MAP[lower]);
    // Check prefixed names (e.g. Dockerfile.prod)
    if (lower.startsWith('dockerfile')) return _resolve('dockerfile');
    const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    const byExt = EXT_MAP[ext];
    return _resolve(byExt || 'file');
}

/**
 * Return the icon value for a given icon key (as returned by the backend).
 * Returns FA class for folders, SVG path for files.
 */
export function iconPath(key) {
    if (key === 'folder') return 'fa-solid fa-folder';
    return _resolve(key || 'file');
}

/** Set the icon theme ('light' or 'dark'). */
export function setIconTheme(theme) {
    _theme = theme;
}

/** Extensions that are binary / non-text (not editable in the code editor). */
const BINARY_EXTS = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'svg',
    'pdf', 'zip', 'tar', 'gz', 'bz2', '7z', 'rar', 'xz', 'whl', 'egg',
    'pyc', 'pyo', 'so', 'dll', 'exe', 'dylib', 'o', 'a', 'bin',
    'parquet', 'feather', 'h5', 'hdf5', 'pickle', 'pkl',
    'mp3', 'wav', 'ogg', 'flac', 'aac',
    'mp4', 'avi', 'mkv', 'mov', 'webm',
    'ttf', 'otf', 'woff', 'woff2', 'eot',
    'pem', 'crt', 'cer', 'key', 'p12', 'pfx',
    'sqlite', 'db',
]);

/** Check if a filename is a text-editable file (not binary, not notebook). */
export function isTextEditable(filename) {
    const name = filename.split('/').pop().toLowerCase();
    const ext = name.includes('.') ? name.split('.').pop() : '';
    if (ext === 'ipynb') return false;
    return !BINARY_EXTS.has(ext);
}

/**
 * Determine the media type for a filename.
 * Returns 'image', 'audio', 'video', 'pdf', 'markdown', or null.
 */
export function mediaType(filename) {
    const name = filename.split('/').pop().toLowerCase();
    const ext = name.includes('.') ? name.split('.').pop() : '';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return 'image';
    if (['mp3', 'wav', 'ogg', 'flac', 'aac'].includes(ext)) return 'audio';
    if (['mp4', 'avi', 'mkv', 'mov', 'webm'].includes(ext)) return 'video';
    if (ext === 'pdf') return 'pdf';
    if (ext === 'md' || ext === 'markdown') return 'markdown';
    return null;
}

/** Check if a file should open in the media viewer (not the text editor). */
export function isMediaViewable(filename) {
    const t = mediaType(filename);
    return t === 'image' || t === 'audio' || t === 'video' || t === 'pdf';
}

/** Folder icon (FA class). */
export const FOLDER_ICON = 'fa-solid fa-folder';
export const FOLDER_OPEN_ICON = 'fa-solid fa-folder-open';
export const FILE_ICON = ICON_BASE + 'file.svg';
