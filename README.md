# PDF Markup

A browser-based PDF viewer and markup tool on a Java EE stack (JSF, PrimeFaces, WildFly,
PDFBox). Built for engineers who get PDFs from another system (for example NX or Teamcenter
exports of system diagrams) and need to reorder pages, rotate them, and add comments.

The user opens a PDF from their own hard drive, works on it in the browser, and downloads a
**new copy**. The original file is never changed, and nothing is stored on the server.

## What it does

- View with zoom, fit-to-width and page thumbnails (rendered in the browser by PDF.js)
- Page operations: rotate, delete, reorder (drag thumbnails or Move up/down), add a blank
  page, insert all pages from another PDF
- Markup: highlight, box, freehand drawing, text, and comments (saved as real PDF note
  annotations that Acrobat and other readers show as comments)
- Select, move, recolor and delete markup, and change text size or line weight; undo and redo
  for everything
- Optional "Marked up by <user> <date>" footer on every page
- Large drawings: the page canvas is capped to a size browsers can handle

## How it works

```
Browser                                   Server (WildFly)
-------                                   ----------------
PDF.js draws pages                        PdfApplyServlet  POST /api/pdf/apply
Model keeps page order, rotation,   --->    SpecParser      JSON  -> EditSpec
and markup until you press Save             PdfEditService  EditSpec + PDFs -> new PDF (PDFBox)
                                    <---  returns the PDF; temp file deleted
```

The PDF is sent to the server only when you press **Save copy**. Markup is stored in the
browser in page coordinates, so it moves with its page and survives rotation. Text typed while
a page is turned is rotated back so it reads upright in that view.

## Requirements

- WildFly 18 (Java EE 8: JSF 2.3, Servlet 4.0, JSON-P 1.1, CDI 2.0). The project uses the
  `javax.*` namespace and PrimeFaces 10.
- Java 8 or newer to build and run (WildFly 18 runs on Java 8 to 13). The code is compiled for
  Java 8.
- Maven 3.8+

**Moving to WildFly 27 or newer later.** Those versions use Jakarta EE 10 (`jakarta.*`), so the
move is mechanical: change `javax.servlet` / `javax.json` imports to `jakarta.*`, switch the
POM to `jakarta.platform:jakarta.jakartaee-web-api:10.0.0` and PrimeFaces 13 or 14 with the
`jakarta` classifier, and update the namespaces in `web.xml`, `faces-config.xml`, `beans.xml`
and `index.xhtml`. Nothing in the browser code or the PDF engine changes. Tell me when you
get there and I can do it.

## Build and deploy

```
mvn clean package
cp target/pdf-markup.war $WILDFLY_HOME/standalone/deployments/
```

Open `http://localhost:8080/pdf-markup/`.

**Upload size.** WildFly's HTTP listener rejects request bodies over 10 MB by default. Large
drawings need a higher limit (here 600 MB, matching `@MultipartConfig` in `PdfApplyServlet`):

```
/subsystem=undertow/server=default-server/http-listener=default:write-attribute(name=max-post-size, value=629145600)
```

If you sit behind a reverse proxy, raise its body limit as well.

## Eclipse notes

The WildFly 18 project (`pdf-markup`) and the Jakarta EE 10 project (`pdf-markup-ee10`) have
different names so they can coexist, but use the one that matches the server you deploy to.
Import with **File > Import > Existing Maven Projects**.

If the wrong libraries seem to be deployed (for example `javax.faces` errors on WildFly 32):

1. Right-click the project > **Maven > Update Project** (Alt+F5), tick **Force Update**.
2. In the **Servers** view, right-click the server > **Add and Remove...** and remove any old
   `pdf-markup` entry, then add the correct project.
3. Right-click the server > **Clean...** and **Clean Server Work Directory**. Eclipse keeps an
   exploded copy of the last published WAR (under
   `<workspace>/.metadata/.plugins/org.eclipse.wst.server.core/tmp0/wtpwebapps`), and stale
   jars from an earlier import can stay in it.
4. If you deploy a WAR by hand, check what is inside it:
   `unzip -l target/*.war | grep -i primefaces`. The WildFly 18 build must contain
   `primefaces-10.0.0.jar`. The Jakarta build must contain `primefaces-14.0.5-jakarta.jar`.
   Remove any old WAR and its `.deployed`/`.failed` marker files before copying a new one.

A recent Eclipse is needed for the Jakarta project's `web.xml` version 6.0. An older one may
flag it in the editor, but `mvn clean package` does not depend on that.

## Tests

```
mvn test                            # Java: PDF engine, with rendered-pixel checks
cd src/test/js && npm install && npm test   # browser logic and UI wiring (Node 20+)
```

- `PdfEditServiceTest` renders output pages and checks that markup lands where the user drew
  it for every combination of page rotation (0/90/180/270) and user rotation (0/90/180/270),
  and that reorder, delete, blank pages, importing from a second file, inherited page
  attributes, comments and error cases work.
- `viewer-logic.test.mjs` covers the coordinate maths, page model, undo/redo, hit testing and
  the request the browser builds.
- `ui-smoke.test.mjs` runs the real `markup.js` against the real `index.xhtml` structure in
  jsdom, with PDF.js and canvas drawing stubbed.

## What has and has not been verified

Verified in development: the PDF engine (10 tests, compiled with `--release 8`), the browser
logic (14 tests), the UI wiring (15 tests), and the browser-built JSON going through
`SpecParser` and the engine together, with the rendered output checked by eye. The servlet and
parser were compile-checked against the Servlet 4.0 API and a JSON-P 1.1-style stand-in.

Not verified yet, because the build environment had no access to Maven Central, a WildFly
server, or a real browser:

- The Maven build itself (the engine was compiled and tested against PDFBox 2.0.29 from the OS
  package; the POM pins 2.0.31, which has the same API)
- Deployment on WildFly 18: the JSF page with PrimeFaces 10 on JSF 2.3, the servlet's multipart
  handling, the `.mjs` MIME mapping
- Drawing real pages with PDF.js in a browser, and the look of the interface
- Behavior on real NX or Teamcenter exports (very large pages, many layers, links, bookmarks)

Please run it against a few real files before relying on it.

## Limits to know about

- Existing text in the PDF cannot be edited, only covered or annotated. PDFs do not store text
  as editable paragraphs.
- Markup (highlight, box, drawing, text) is burned into the saved copy and cannot be removed
  afterward in other tools. Comments are real annotations and can be.
- Typed text uses Helvetica and supports Latin-1 characters; others are replaced with `?`.
- Password-protected PDFs are not supported, and PDFs that forbid modification are refused.
- Each source page can appear once (no duplicate-page command yet). Bookmarks that point to
  deleted pages are left dangling.
- Mouse and pen only; touch panning is not handled.
- Inserting pages from another PDF copies the pages only, not that file's bookmarks.

## Project layout

```
src/main/java/com/example/pdfmarkup/
  model/EditSpec.java            what the browser asks for
  service/PdfEditService.java    applies it with PDFBox
  service/BusinessException.java user-facing errors
  web/PdfApplyServlet.java       upload / download endpoint
  web/SpecParser.java            JSON -> EditSpec
src/main/webapp/
  index.xhtml                    JSF/PrimeFaces page
  resources/css/markup.css
  static/js/geometry.js          coordinate maths (tested in Node)
  static/js/model.js             pages, markup, undo (tested in Node)
  static/js/markup.js            UI: rendering, tools, save
  static/pdfjs/                  PDF.js (Apache 2.0), bundled so no internet is needed
```

Rename the `com.example` package to your own before shipping.

## Security notes

- The endpoint requires an `X-Requested-With: pdf-markup` header, which browsers will not add
  to a cross-site form post.
- If the app sits behind your normal login, `request.getRemoteUser()` is used for the optional
  footer. Without a login the footer shows only the date.
- Uploads are written to a temp file and deleted at the end of each request.
