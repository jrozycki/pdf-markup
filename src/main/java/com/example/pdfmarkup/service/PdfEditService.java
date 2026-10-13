package com.example.pdfmarkup.service;

import java.awt.Color;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import org.apache.pdfbox.io.MemoryUsageSetting;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.PDPageContentStream.AppendMode;
import org.apache.pdfbox.pdmodel.PDPageTree;
import org.apache.pdfbox.pdmodel.PDResources;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.font.PDFont;
import org.apache.pdfbox.pdmodel.font.PDType1Font;
import org.apache.pdfbox.pdmodel.graphics.state.PDExtendedGraphicsState;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotation;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotationText;
import org.apache.pdfbox.pdmodel.encryption.InvalidPasswordException;
import org.apache.pdfbox.util.Matrix;

import com.example.pdfmarkup.model.EditSpec;
import com.example.pdfmarkup.model.EditSpec.Markup;
import com.example.pdfmarkup.model.EditSpec.PageSpec;

/**
 * Applies an {@link EditSpec} to one or more PDF files and writes the result.
 *
 * <p>
 * The first source is edited in place so document-level data (metadata, bookmarks, named
 * destinations) survives. Pages taken from other sources are copied into it.
 * </p>
 */
public class PdfEditService {

    public static final int MAX_PAGES = 2000;
    public static final int MAX_MARKUPS_PER_PAGE = 5000;

    private static final long MEMORY_BEFORE_TEMP_FILE = 64L * 1024 * 1024;
    private static final float HIGHLIGHT_ALPHA = 0.35f;
    /** Distance from the top of a text line to its baseline, as a fraction of the font size. */
    private static final double ASCENT = 0.8;
    private static final double LINE_HEIGHT = 1.2;
    private static final float NOTE_SIZE = 20f;
    private static final double STAMP_SIZE = 7;

    public void apply(EditSpec spec, List<InputStream> sources, OutputStream out) {
        validate(spec, sources.size());

        List<PDDocument> docs = new ArrayList<>();
        try {
            for (int i = 0; i < sources.size(); i++) {
                docs.add(load(sources.get(i), i));
            }
            validateAgainstDocuments(spec, docs);

            PDDocument base = docs.get(0);
            if (!base.getCurrentAccessPermission().canModify()) {
                throw new BusinessException("This PDF does not allow modification.");
            }

            // Pages lose inherited properties (size, resources, rotation) when they move to a
            // different parent, so write them onto each page first.
            List<PDPage> basePages = new ArrayList<>();
            for (PDPage page : base.getPages()) {
                materializeInheritedAttributes(page);
                basePages.add(page);
            }

            List<PDPage> ordered = new ArrayList<>();
            for (PageSpec pageSpec : spec.getPages()) {
                PDPage page = resolvePage(base, docs, basePages, pageSpec);
                int nativeRotation = normalizeRotation(page.getRotation());
                drawMarkup(base, page, nativeRotation, pageSpec.getRotate(), pageSpec.getMarkups(),
                        spec);
                page.setRotation((nativeRotation + pageSpec.getRotate()) % 360);
                ordered.add(page);
            }

            PDPageTree tree = base.getPages();
            while (tree.getCount() > 0) {
                tree.remove(0);
            }
            for (PDPage page : ordered) {
                tree.add(page);
            }

            base.save(out);
        } catch (IOException e) {
            throw new BusinessException("Could not write the edited PDF: " + e.getMessage(), e);
        } finally {
            for (PDDocument doc : docs) {
                try {
                    doc.close();
                } catch (IOException ignored) {
                    // nothing useful to do
                }
            }
        }
    }

    // ---------------------------------------------------------------- validation

    private void validate(EditSpec spec, int sourceCount) {
        if (sourceCount == 0) {
            throw new BusinessException("No PDF was uploaded.");
        }
        List<PageSpec> pages = spec.getPages();
        if (pages == null || pages.isEmpty()) {
            throw new BusinessException("The edited document must keep at least one page.");
        }
        if (pages.size() > MAX_PAGES) {
            throw new BusinessException("Too many pages (limit is " + MAX_PAGES + ").");
        }
        Set<String> used = new HashSet<>();
        for (int i = 0; i < pages.size(); i++) {
            PageSpec p = pages.get(i);
            String label = "Page " + (i + 1);
            if (p.getRotate() != 0 && p.getRotate() != 90 && p.getRotate() != 180
                    && p.getRotate() != 270) {
                throw new BusinessException(label + ": rotation must be 0, 90, 180 or 270.");
            }
            if (p.getMarkups() != null && p.getMarkups().size() > MAX_MARKUPS_PER_PAGE) {
                throw new BusinessException(label + " has too many markups.");
            }
            if (p.isBlank()) {
                if (!(p.getBlankWidth() >= 10 && p.getBlankWidth() <= 14400
                        && p.getBlankHeight() >= 10 && p.getBlankHeight() <= 14400)) {
                    throw new BusinessException(label + ": blank page size is out of range.");
                }
                continue;
            }
            if (p.getDoc() < 0 || p.getDoc() >= sourceCount) {
                throw new BusinessException(label + " refers to a file that was not uploaded.");
            }
            if (!used.add(p.getDoc() + ":" + p.getSrc())) {
                throw new BusinessException(label + " uses a source page that already appears "
                        + "earlier. Each source page can be used once.");
            }
        }
    }

    private void validateAgainstDocuments(EditSpec spec, List<PDDocument> docs) {
        for (int i = 0; i < spec.getPages().size(); i++) {
            PageSpec p = spec.getPages().get(i);
            if (p.isBlank()) {
                continue;
            }
            int count = docs.get(p.getDoc()).getNumberOfPages();
            if (p.getSrc() < 0 || p.getSrc() >= count) {
                throw new BusinessException("Page " + (i + 1) + " refers to page "
                        + (p.getSrc() + 1) + " of a file that only has " + count + ".");
            }
            if (p.getDoc() != 0 && !docs.get(p.getDoc()).getCurrentAccessPermission()
                    .canExtractContent()) {
                throw new BusinessException(
                        "A file you are inserting pages from does not allow copying content.");
            }
        }
    }

    private PDDocument load(InputStream in, int index) {
        try {
            return PDDocument.load(in,
                    MemoryUsageSetting.setupMixed(MEMORY_BEFORE_TEMP_FILE));
        } catch (InvalidPasswordException e) {
            throw new BusinessException(
                    "File " + (index + 1) + " is password-protected. Remove the password first.",
                    e);
        } catch (IOException e) {
            throw new BusinessException("File " + (index + 1) + " is not a readable PDF.", e);
        }
    }

    // ---------------------------------------------------------------- page handling

    private PDPage resolvePage(PDDocument base, List<PDDocument> docs, List<PDPage> basePages,
            PageSpec spec) throws IOException {
        if (spec.isBlank()) {
            return new PDPage(new PDRectangle((float) spec.getBlankWidth(),
                    (float) spec.getBlankHeight()));
        }
        if (spec.getDoc() == 0) {
            return basePages.get(spec.getSrc());
        }
        PDPage source = docs.get(spec.getDoc()).getPage(spec.getSrc());
        return base.importPage(source);
    }

    private void materializeInheritedAttributes(PDPage page) {
        page.setMediaBox(page.getMediaBox());
        page.setCropBox(page.getCropBox());
        page.setRotation(page.getRotation());
        PDResources resources = page.getResources();
        if (resources != null) {
            page.setResources(resources);
        }
    }

    private static int normalizeRotation(int rotation) {
        return ((rotation % 360) + 360) % 360;
    }

    // ---------------------------------------------------------------- markup

    private void drawMarkup(PDDocument doc, PDPage page, int nativeRotation, int userRotation,
            List<Markup> markups, EditSpec spec) throws IOException {
        boolean hasMarkups = markups != null && !markups.isEmpty();
        if (!hasMarkups && !spec.isStamp()) {
            return;
        }

        Geometry geometry = new Geometry(page.getCropBox(), nativeRotation);
        List<PDAnnotation> notes = new ArrayList<>();

        try (PDPageContentStream cs = new PDPageContentStream(doc, page, AppendMode.APPEND,
                true, true)) {
            if (hasMarkups) {
                for (Markup m : markups) {
                    if (m.getType() == null) {
                        continue;
                    }
                    switch (m.getType()) {
                    case HIGHLIGHT:
                        drawHighlight(cs, geometry, m);
                        break;
                    case RECT:
                        drawRect(cs, geometry, m);
                        break;
                    case INK:
                        drawInk(cs, geometry, m);
                        break;
                    case TEXT:
                        drawText(cs, geometry, m.getText(), m.getX(), m.getY(),
                                clamp(m.getFontSize(), 4, 200), parseColor(m.getColor()),
                                m.getAngle());
                        break;
                    case NOTE:
                        notes.add(buildNote(geometry, m));
                        break;
                    default:
                        break;
                    }
                }
            }
            if (spec.isStamp() && spec.getStampText() != null) {
                drawStamp(cs, geometry, spec.getStampText(), userRotation);
            }
        }

        if (!notes.isEmpty()) {
            List<PDAnnotation> annotations = page.getAnnotations();
            annotations.addAll(notes);
            page.setAnnotations(annotations);
        }
    }

    /**
     * Prints the footer at the bottom-left of the page as it will look after the user's
     * rotation, reading upright there.
     */
    private void drawStamp(PDPageContentStream cs, Geometry g, String text, int userRotation)
            throws IOException {
        boolean sideways = userRotation == 90 || userRotation == 270;
        double viewHeight = sideways ? g.displayWidth : g.displayHeight;
        double[] anchor = viewToBase(8, viewHeight - 6 - ASCENT * STAMP_SIZE, g.displayWidth,
                g.displayHeight, userRotation);
        drawText(cs, g, text, anchor[0], anchor[1], STAMP_SIZE, new Color(0x55, 0x55, 0x55),
                (360 - userRotation) % 360);
    }

    /** Inverse of turning a page of (w, h) clockwise by {@code rotation} degrees. */
    static double[] viewToBase(double vx, double vy, double w, double h, int rotation) {
        switch (rotation) {
        case 90:
            return new double[] { vy, h - vx };
        case 180:
            return new double[] { w - vx, h - vy };
        case 270:
            return new double[] { w - vy, vx };
        default:
            return new double[] { vx, vy };
        }
    }

    private void drawHighlight(PDPageContentStream cs, Geometry g, Markup m)
            throws IOException {
        cs.saveGraphicsState();
        PDExtendedGraphicsState state = new PDExtendedGraphicsState();
        state.setNonStrokingAlphaConstant(HIGHLIGHT_ALPHA);
        cs.setGraphicsStateParameters(state);
        cs.setNonStrokingColor(parseColor(m.getColor()));
        polygon(cs, g, rectCorners(m));
        cs.fill();
        cs.restoreGraphicsState();
    }

    private void drawRect(PDPageContentStream cs, Geometry g, Markup m) throws IOException {
        cs.saveGraphicsState();
        cs.setStrokingColor(parseColor(m.getColor()));
        cs.setLineWidth((float) clamp(m.getLineWidth(), 0.25, 50));
        cs.setLineJoinStyle(0);
        polygon(cs, g, rectCorners(m));
        cs.stroke();
        cs.restoreGraphicsState();
    }

    private void drawInk(PDPageContentStream cs, Geometry g, Markup m) throws IOException {
        List<double[]> points = m.getPoints();
        if (points == null || points.size() < 2) {
            return;
        }
        cs.saveGraphicsState();
        cs.setStrokingColor(parseColor(m.getColor()));
        cs.setLineWidth((float) clamp(m.getLineWidth(), 0.25, 50));
        cs.setLineCapStyle(1);
        cs.setLineJoinStyle(1);
        boolean first = true;
        for (double[] p : points) {
            if (p == null || p.length < 2) {
                continue;
            }
            float[] u = g.toUser(p[0], p[1]);
            if (first) {
                cs.moveTo(u[0], u[1]);
                first = false;
            } else {
                cs.lineTo(u[0], u[1]);
            }
        }
        cs.stroke();
        cs.restoreGraphicsState();
    }

    /**
     * Draws text at (x, y), the top-left of the first line before rotation, turned clockwise by
     * {@code angle} degrees about that point, on the page as the user saw it. With angle 0 the
     * text reads upright on the page as displayed, whatever the page's own rotation is.
     */
    private void drawText(PDPageContentStream cs, Geometry g, String text, double x, double y,
            double fontSize, Color color, double angle) throws IOException {
        if (text == null || text.trim().isEmpty()) {
            return;
        }
        PDFont font = PDType1Font.HELVETICA;
        double theta = Math.toRadians(angle);
        // PDF angles run counter-clockwise; the page's own rotation is clockwise on screen.
        double pdfAngle = Math.toRadians(g.rotation) - theta;
        cs.saveGraphicsState();
        cs.setNonStrokingColor(color);
        String[] lines = text.replace("\r", "").split("\n", -1);
        for (int i = 0; i < lines.length; i++) {
            String line = sanitize(font, lines[i]);
            if (line.isEmpty()) {
                continue;
            }
            double down = ASCENT * fontSize + i * LINE_HEIGHT * fontSize;
            float[] origin = g.toUser(x - down * Math.sin(theta), y + down * Math.cos(theta));
            cs.beginText();
            cs.setFont(font, (float) fontSize);
            cs.setTextMatrix(Matrix.getRotateInstance(pdfAngle, origin[0], origin[1]));
            cs.showText(line);
            cs.endText();
        }
        cs.restoreGraphicsState();
    }

    private PDAnnotation buildNote(Geometry g, Markup m) {
        float[] a = g.toUser(m.getX(), m.getY());
        float[] b = g.toUser(m.getX() + NOTE_SIZE, m.getY() + NOTE_SIZE);
        PDRectangle rect = new PDRectangle(Math.min(a[0], b[0]), Math.min(a[1], b[1]),
                Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
        PDAnnotationText note = new PDAnnotationText();
        note.setRectangle(rect);
        note.setContents(m.getText() == null ? "" : m.getText());
        note.setName(PDAnnotationText.NAME_COMMENT);
        note.setPrinted(true);
        return note;
    }

    private static double[][] rectCorners(Markup m) {
        double x = Math.min(m.getX(), m.getX() + m.getWidth());
        double y = Math.min(m.getY(), m.getY() + m.getHeight());
        double w = Math.abs(m.getWidth());
        double h = Math.abs(m.getHeight());
        return new double[][] { { x, y }, { x + w, y }, { x + w, y + h }, { x, y + h } };
    }

    private static void polygon(PDPageContentStream cs, Geometry g, double[][] corners)
            throws IOException {
        for (int i = 0; i < corners.length; i++) {
            float[] u = g.toUser(corners[i][0], corners[i][1]);
            if (i == 0) {
                cs.moveTo(u[0], u[1]);
            } else {
                cs.lineTo(u[0], u[1]);
            }
        }
        cs.closePath();
    }

    private static String sanitize(PDFont font, String line) {
        StringBuilder sb = new StringBuilder(line.length());
        for (int i = 0; i < line.length(); i++) {
            char c = line.charAt(i);
            if (c == '\t') {
                sb.append("    ");
                continue;
            }
            if (c < 32) {
                sb.append(' ');
                continue;
            }
            try {
                font.encode(String.valueOf(c));
                sb.append(c);
            } catch (IllegalArgumentException | IOException e) {
                sb.append('?');
            }
        }
        return sb.toString();
    }

    private static Color parseColor(String hex) {
        try {
            return Color.decode(hex);
        } catch (RuntimeException e) {
            return new Color(0xd3, 0x2f, 0x2f);
        }
    }

    private static double clamp(double value, double min, double max) {
        if (Double.isNaN(value)) {
            return min;
        }
        return Math.max(min, Math.min(max, value));
    }

    /**
     * Converts positions on the page as the user saw it (points, origin top-left, y down) into
     * PDF user space (origin bottom-left of the crop box, y up), for a page whose own /Rotate
     * is {@code rotation}.
     */
    static final class Geometry {

        final float originX;
        final float originY;
        final float width;
        final float height;
        final int rotation;
        final double displayWidth;
        final double displayHeight;

        Geometry(PDRectangle box, int rotation) {
            this.originX = box.getLowerLeftX();
            this.originY = box.getLowerLeftY();
            this.width = box.getWidth();
            this.height = box.getHeight();
            this.rotation = rotation;
            boolean sideways = rotation == 90 || rotation == 270;
            this.displayWidth = sideways ? height : width;
            this.displayHeight = sideways ? width : height;
        }

        float[] toUser(double dx, double dy) {
            double x;
            double y;
            switch (rotation) {
            case 90:
                x = dy;
                y = dx;
                break;
            case 180:
                x = width - dx;
                y = dy;
                break;
            case 270:
                x = width - dy;
                y = height - dx;
                break;
            default:
                x = dx;
                y = height - dy;
                break;
            }
            return new float[] { (float) (originX + x), (float) (originY + y) };
        }
    }
}
