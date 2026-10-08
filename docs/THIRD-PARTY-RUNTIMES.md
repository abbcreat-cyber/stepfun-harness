# Runtime notices / 运行时声明

The installer redistributes unmodified third-party runtime distributions. Their original license and notice files remain inside `resources/harness-runtime`; the application license does not replace them.
安装包包含独立许可的第三方运行时；原许可保留在对应目录，主工程许可不替代第三方条款。

| Runtime | Version | Source and license information |
|---|---|---|
| Step Code | 0.1.3 | [Source](https://github.com/stepfun-ai/Step-Code), MIT and bundled dependency notices |
| Node.js | 24.18.0 | [Exact source archive](https://nodejs.org/dist/v24.18.0/node-v24.18.0.tar.xz), MIT and component notices in `node/LICENSE` |
| CPython | 3.12.10 | [Exact source archive](https://www.python.org/ftp/python/3.12.10/Python-3.12.10.tar.xz), PSF license in embedded distribution |
| Git for Windows | 2.56.0.windows.2 | [Release and corresponding source](https://github.com/git-for-windows/git/releases/tag/v2.56.0.windows.2), GPL-2.0 and component licenses in `git/` |
| LibreOffice | 25.8.4.2 | [Corresponding source](https://downloadarchive.documentfoundation.org/libreoffice/old/25.8.4.2/src/), MPL-2.0 / LGPL and bundled component notices |
| PyMuPDF | 1.28.2 | [Source release](https://github.com/pymupdf/PyMuPDF/tree/1.28.2), AGPL-3.0 / commercial dual licensing; this package uses the AGPL distribution |
| Python document libraries | See lockfile | Versions are pinned in `tools/documents/requirements.lock.txt`; upstream metadata and licenses remain in each `.dist-info` directory |
| Node document libraries | See lockfile | Versions and integrity hashes are in `tools/documents/package-lock.json`; each package retains its license |

The Git, LibreOffice and PyMuPDF distributions are unmodified. The source links identify their corresponding upstream source; obtain the matching source and preserve its license when redistributing or modifying these components. Non-commercial restrictions on the original document skills are separately listed in [LICENSES.md](../LICENSES.md).
