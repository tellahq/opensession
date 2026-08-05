type FrontendShellOptions = {
	instance: string;
	productName: string;
	entryName: string;
	tailwindCssName: string;
};

function replaceRequired(source: string, marker: string, replacement: string): string {
	const occurrences = source.split(marker).length - 1;
	if (occurrences !== 1) {
		throw new Error(`frontend shell marker must occur exactly once: ${marker}`);
	}
	return source.replace(marker, replacement);
}

function replaceAllRequired(source: string, marker: string, replacement: string): string {
	if (!source.includes(marker)) {
		throw new Error(`frontend shell marker is missing: ${marker}`);
	}
	return source.replaceAll(marker, replacement);
}

export function assembleFrontendShell(source: string, options: FrontendShellOptions): string {
	let html = replaceRequired(
		source,
		"window.__OPENSESSION_INSTANCE__ = window.__OPENSESSION_INSTANCE__ || {};",
		`window.__OPENSESSION_INSTANCE__ = ${options.instance};`,
	);
	html = replaceRequired(html, "<title>OpenSession</title>", `<title>${options.productName}</title>`);
	html = replaceAllRequired(html, 'content="OpenSession"', `content="${options.productName}"`);
	html = replaceRequired(
		html,
		'<script type="module" src="./App.tsx"></script>',
		`<script type="module" crossorigin src="/${options.entryName}"></script>`,
	);
	html = replaceRequired(
		html,
		"</head>",
		`  <link rel="stylesheet" href="/${options.tailwindCssName}">\n</head>`,
	);
	return html;
}
