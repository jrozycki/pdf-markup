#!/usr/bin/env python3
"""
Produces the Jakarta EE 10 variant (WildFly 27 and newer, including 32) of this project.

This project is maintained for Java EE 8 (WildFly 18). Run:

    python3 tools/to-jakarta.py ../pdf-markup-jakarta

The browser code and the PDF engine are identical in both variants. Only the servlet and JSON
parser imports, the deployment descriptors, the POM and the page's tag namespace differ.
"""
import os
import shutil
import sys

SRC = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def replace_in(path, pairs):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    for old, new in pairs:
        if old not in text:
            sys.exit(f"{path}: expected text not found:\n{old}")
        text = text.replace(old, new)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def main(dest):
    if os.path.exists(dest):
        sys.exit(f"{dest} already exists; remove it first")
    shutil.copytree(SRC, dest, ignore=shutil.ignore_patterns(
        "node_modules", "target", ".git", "tools"))

    # Java imports
    for root, _, files in os.walk(os.path.join(dest, "src/main/java")):
        for name in files:
            if name.endswith(".java"):
                path = os.path.join(root, name)
                with open(path, encoding="utf-8") as f:
                    text = f.read()
                text = text.replace("import javax.servlet", "import jakarta.servlet")
                text = text.replace("import javax.json", "import jakarta.json")
                with open(path, "w", encoding="utf-8") as f:
                    f.write(text)

    # POM
    replace_in(os.path.join(dest, "pom.xml"), [
        ("<artifactId>pdf-markup</artifactId>", "<artifactId>pdf-markup-ee10</artifactId>"),
        ("<name>PDF Markup</name>", "<name>PDF Markup (Jakarta EE 10)</name>"),
        ("<finalName>pdf-markup</finalName>", "<finalName>pdf-markup-ee10</finalName>"),
        ("<maven.compiler.release>8</maven.compiler.release>",
         "<maven.compiler.release>11</maven.compiler.release>"),
        ("<primefaces.version>10.0.0</primefaces.version>",
         "<primefaces.version>14.0.5</primefaces.version>"),
        ("""        <!-- Java EE 8 (WildFly 18). Provided by the server. -->
        <dependency>
            <groupId>javax</groupId>
            <artifactId>javaee-web-api</artifactId>
            <version>8.0.1</version>
            <scope>provided</scope>
        </dependency>""",
         """        <!-- Jakarta EE 10 (WildFly 27+). Provided by the server. -->
        <dependency>
            <groupId>jakarta.platform</groupId>
            <artifactId>jakarta.jakartaee-web-api</artifactId>
            <version>10.0.0</version>
            <scope>provided</scope>
        </dependency>"""),
        ("            <version>${primefaces.version}</version>\n",
         "            <version>${primefaces.version}</version>\n"
         "            <classifier>jakarta</classifier>\n"),
    ])

    # Page namespace
    replace_in(os.path.join(dest, "src/main/webapp/index.xhtml"), [
        ('xmlns:h="http://xmlns.jcp.org/jsf/html"', 'xmlns:h="jakarta.faces.html"'),
    ])

    # Deployment descriptors
    web = os.path.join(dest, "src/main/webapp/WEB-INF")
    replace_in(os.path.join(web, "web.xml"), [
        ('xmlns="http://xmlns.jcp.org/xml/ns/javaee"', 'xmlns="https://jakarta.ee/xml/ns/jakartaee"'),
        ('xsi:schemaLocation="http://xmlns.jcp.org/xml/ns/javaee http://xmlns.jcp.org/xml/ns/javaee/web-app_4_0.xsd"',
         'xsi:schemaLocation="https://jakarta.ee/xml/ns/jakartaee https://jakarta.ee/xml/ns/jakartaee/web-app_6_0.xsd"'),
        ('version="4.0"', 'version="6.0"'),
        ("javax.faces.PROJECT_STAGE", "jakarta.faces.PROJECT_STAGE"),
        ("javax.faces.FACELETS_SKIP_COMMENTS", "jakarta.faces.FACELETS_SKIP_COMMENTS"),
        ("javax.faces.webapp.FacesServlet", "jakarta.faces.webapp.FacesServlet"),
    ])
    replace_in(os.path.join(web, "faces-config.xml"), [
        ('xmlns="http://xmlns.jcp.org/xml/ns/javaee"', 'xmlns="https://jakarta.ee/xml/ns/jakartaee"'),
        ('xsi:schemaLocation="http://xmlns.jcp.org/xml/ns/javaee http://xmlns.jcp.org/xml/ns/javaee/web-facesconfig_2_3.xsd"',
         'xsi:schemaLocation="https://jakarta.ee/xml/ns/jakartaee https://jakarta.ee/xml/ns/jakartaee/web-facesconfig_4_0.xsd"'),
        ('version="2.3"', 'version="4.0"'),
    ])
    replace_in(os.path.join(web, "beans.xml"), [
        ('xmlns="http://xmlns.jcp.org/xml/ns/javaee"', 'xmlns="https://jakarta.ee/xml/ns/jakartaee"'),
        ('xsi:schemaLocation="http://xmlns.jcp.org/xml/ns/javaee http://xmlns.jcp.org/xml/ns/javaee/beans_2_0.xsd"',
         'xsi:schemaLocation="https://jakarta.ee/xml/ns/jakartaee https://jakarta.ee/xml/ns/jakartaee/beans_4_0.xsd"'),
        ('version="2.0"', 'version="4.0"'),
    ])

    # README
    readme = os.path.join(dest, "README.md")
    with open(readme, encoding="utf-8") as f:
        text = f.read()
    start = text.index("## Requirements")
    end = text.index("## Build and deploy")
    text = text[:start] + """## Requirements

This is the **Jakarta EE 10** variant, for WildFly 27 and newer (including 32). It uses the
`jakarta.*` namespace and PrimeFaces 14. For WildFly 18 and other Java EE 8 servers use the
`javax.*` variant, which is the one maintained by hand; this one is generated from it with
`tools/to-jakarta.py`.

- Java 11 or newer to build and run
- Maven 3.8+

The Maven project and WAR are named `pdf-markup-ee10` (not `pdf-markup`) so this variant and
the WildFly 18 one can be imported into Eclipse and deployed side by side without clashing.
The application URL is therefore `/pdf-markup-ee10/`.

""" + text[end:]
    with open(readme, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"Created {dest}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(os.path.abspath(sys.argv[1]))
