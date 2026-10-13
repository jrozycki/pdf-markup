package com.example.pdfmarkup.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import javax.imageio.ImageIO;

import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotation;
import org.apache.pdfbox.rendering.PDFRenderer;
import org.junit.jupiter.api.Test;

import com.example.pdfmarkup.model.EditSpec;
import com.example.pdfmarkup.model.EditSpec.Markup;
import com.example.pdfmarkup.model.EditSpec.MarkupType;
import com.example.pdfmarkup.model.EditSpec.PageSpec;

class PdfEditServiceTest {

    private static final int[] ROTATIONS = { 0, 90, 180, 270 };
    private static final float BASE_W = 400;
    private static final float BASE_H = 300;

    private final PdfEditService service = new PdfEditService();

    // ------------------------------------------------------------ geometry

    /** Markup must land where the user drew it, for every native page rotation. */
    @Test
    void markupLandsWhereUserSawIt() throws Exception {
        for (int nativeRot : ROTATIONS) {
            byte[] pdf = blankPdf(nativeRot, 1);
            Markup m = highlight(100, 50, 60, 40);
            byte[] out = run(pdf, spec(page(0, 0, 0, m)));

            BufferedImage img = render(out, 0);
            String ctx = "native rotation " + nativeRot;
            assertTrue(isReddish(img, 130, 70), ctx + ": highlight centre should be red");
            assertTrue(isWhite(img, 30, 30), ctx + ": top-left corner should be untouched");
            assertTrue(isWhite(img, 200, 200), ctx + ": far area should be untouched");
        }
    }

    /** After the user rotates a page, its markup must rotate with it. */
    @Test
    void markupFollowsUserRotation() throws Exception {
        for (int nativeRot : ROTATIONS) {
            for (int delta : ROTATIONS) {
                byte[] pdf = blankPdf(nativeRot, 1);
                boolean sideways = nativeRot == 90 || nativeRot == 270;
                double nativeW = sideways ? BASE_H : BASE_W;
                double nativeH = sideways ? BASE_W : BASE_H;

                byte[] out = run(pdf, spec(page(0, 0, delta, highlight(100, 50, 60, 40))));
                BufferedImage img = render(out, 0);

                double[] expected = rotateForDisplay(130, 70, nativeW, nativeH, delta);
                int ex = (int) Math.round(expected[0]);
                int ey = (int) Math.round(expected[1]);
                String ctx = "native " + nativeRot + ", user rotation " + delta;
                assertTrue(isReddish(img, ex, ey),
                        ctx + ": expected red at " + ex + "," + ey);
                assertTrue(isWhite(img, 5, 5) || (ex < 20 && ey < 20),
                        ctx + ": top-left should be untouched");
            }
        }
    }

    /** Text must read upright as the user saw it; check it sits in the right place. */
    @Test
    void textIsPlacedAtTheClickedPosition() throws Exception {
        for (int nativeRot : ROTATIONS) {
            Markup t = new Markup();
            t.setType(MarkupType.TEXT);
            t.setX(60);
            t.setY(100);
            t.setFontSize(24);
            t.setText("HELLO");
            t.setColor("#000000");

            byte[] out = run(blankPdf(nativeRot, 1), spec(page(0, 0, 0, t)));
            BufferedImage img = render(out, 0);
            dump(img, "text-native-" + nativeRot);

            // "HELLO" at 24pt Helvetica is about 70pt wide and 17pt tall (cap height).
            int inside = darkPixels(img, 60, 100, 140, 130);
            int outside = darkPixels(img, 0, 0, 55, 95) + darkPixels(img, 150, 140, 300, 290);
            assertTrue(inside > 150, "native " + nativeRot + ": text should be at the click, got "
                    + inside);
            assertEquals(0, outside, "native " + nativeRot + ": nothing else should be drawn");
        }
    }

    /**
     * Text added while looking at a rotated page must read upright, at the clicked spot, in
     * that same rotated view.
     */
    @Test
    void textAddedInARotatedViewReadsUprightInThatView() throws Exception {
        for (int nativeRot : ROTATIONS) {
            for (int delta : ROTATIONS) {
                boolean sideways = nativeRot == 90 || nativeRot == 270;
                double nativeW = sideways ? BASE_H : BASE_W;
                double nativeH = sideways ? BASE_W : BASE_H;

                // The user clicks at (60, 100) in the rotated view; find that spot on the page.
                // The inverse rotation starts from the rotated view's own width and height.
                boolean viewSideways = delta == 90 || delta == 270;
                double viewW = viewSideways ? nativeH : nativeW;
                double viewH = viewSideways ? nativeW : nativeH;
                double[] anchor = rotateForDisplay(60, 100, viewW, viewH, (360 - delta) % 360);

                Markup t = new Markup();
                t.setType(MarkupType.TEXT);
                t.setX(anchor[0]);
                t.setY(anchor[1]);
                t.setFontSize(24);
                t.setText("HELLO");
                t.setColor("#000000");
                t.setAngle((360 - delta) % 360);

                byte[] out = run(blankPdf(nativeRot, 1), spec(page(0, 0, delta, t)));
                BufferedImage img = render(out, 0);
                String ctx = "native " + nativeRot + ", user rotation " + delta;
                dump(img, "view-n" + nativeRot + "-d" + delta);

                int inside = darkPixels(img, 60, 100, 140, 130);
                int outside = darkPixels(img, 0, 0, 55, 95) + darkPixels(img, 150, 140, 280, 280);
                assertTrue(inside > 150, ctx + ": text should be at the click, got " + inside);
                assertEquals(0, outside, ctx + ": nothing else should be drawn");
            }
        }
    }

    @Test
    void inkAndRectangleAreDrawn() throws Exception {
        Markup ink = new Markup();
        ink.setType(MarkupType.INK);
        ink.setColor("#0000ff");
        ink.setLineWidth(4);
        List<double[]> pts = new ArrayList<>();
        pts.add(new double[] { 20, 20 });
        pts.add(new double[] { 120, 20 });
        pts.add(new double[] { 120, 120 });
        ink.setPoints(pts);

        Markup rect = new Markup();
        rect.setType(MarkupType.RECT);
        rect.setX(150);
        rect.setY(150);
        rect.setWidth(80);
        rect.setHeight(60);
        rect.setLineWidth(4);
        rect.setColor("#00aa00");

        for (int nativeRot : ROTATIONS) {
            byte[] out = run(blankPdf(nativeRot, 1), spec(page(0, 0, 0, ink, rect)));
            BufferedImage img = render(out, 0);
            String ctx = "native " + nativeRot;
            assertTrue(isColor(img, 70, 20, 0, 0, 255), ctx + ": ink segment 1");
            assertTrue(isColor(img, 120, 70, 0, 0, 255), ctx + ": ink segment 2");
            assertTrue(isColor(img, 190, 150, 0, 170, 0), ctx + ": rectangle top edge");
            assertTrue(isWhite(img, 190, 180), ctx + ": rectangle interior stays empty");
        }
    }

    @Test
    void noteBecomesAPdfCommentAnnotation() throws Exception {
        Markup note = new Markup();
        note.setType(MarkupType.NOTE);
        note.setX(40);
        note.setY(40);
        note.setText("Check valve orientation");

        byte[] out = run(blankPdf(90, 1), spec(page(0, 0, 0, note)));
        try (PDDocument doc = PDDocument.load(out)) {
            List<PDAnnotation> annotations = doc.getPage(0).getAnnotations();
            assertEquals(1, annotations.size());
            assertEquals("Check valve orientation", annotations.get(0).getContents());
        }
    }

    @Test
    void stampStaysUprightAtTheBottomLeftOfTheFinalPage() throws Exception {
        for (int nativeRot : ROTATIONS) {
            for (int delta : ROTATIONS) {
                EditSpec spec = spec(page(0, 0, delta));
                spec.setStamp(true);
                spec.setStampText("Marked up by tester on 2026-10-06");
                BufferedImage img = render(run(blankPdf(nativeRot, 1), spec), 0);
                dump(img, "stamp-n" + nativeRot + "-d" + delta);

                // Upright text on a 7pt line is wider than it is tall; sideways text is the reverse.
                int h = img.getHeight();
                String ctx = "native " + nativeRot + ", user rotation " + delta;
                assertTrue(inkedPixels(img, 6, h - 16, 200, h - 2) > 20,
                        ctx + ": stamp expected at the bottom-left");
                assertEquals(0, inkedPixels(img, 6, 6, 200, h - 30),
                        ctx + ": nothing else should be drawn");
                int[] box = inkBounds(img);
                assertTrue(box[2] - box[0] > 3 * (box[3] - box[1]),
                        ctx + ": stamp should read horizontally");
            }
        }
    }

    // ------------------------------------------------------------ page handling

    @Test
    void reordersDeletesInsertsBlankAndImportsFromAnotherFile() throws Exception {
        byte[] base = sizedPdf(100, 200, 300, 400);
        byte[] other = sizedPdf(500, 600);

        PageSpec blank = new PageSpec();
        blank.setBlank(true);
        blank.setBlankWidth(250);
        blank.setBlankHeight(350);

        // keep base page 3 (width 400), other page 1 (width 600), a blank, base page 0 (100)
        EditSpec spec = spec(page(0, 3, 0), page(1, 1, 90), blank, page(0, 0, 0));
        byte[] out = run(Arrays.asList(base, other), spec);

        try (PDDocument doc = PDDocument.load(out)) {
            assertEquals(4, doc.getNumberOfPages());
            assertEquals(400, doc.getPage(0).getMediaBox().getWidth(), 0.01);
            assertEquals(600, doc.getPage(1).getMediaBox().getWidth(), 0.01);
            assertEquals(90, doc.getPage(1).getRotation());
            assertEquals(250, doc.getPage(2).getMediaBox().getWidth(), 0.01);
            assertEquals(350, doc.getPage(2).getMediaBox().getHeight(), 0.01);
            assertEquals(100, doc.getPage(3).getMediaBox().getWidth(), 0.01);
        }
    }

    @Test
    void pagesKeepTheirSizeAndRotationWhenInheritedFromTheParentNode() throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        try (PDDocument doc = new PDDocument()) {
            for (int i = 0; i < 2; i++) {
                PDPage page = new PDPage();
                page.getCOSObject().removeItem(COSName.MEDIA_BOX);
                doc.addPage(page);
            }
            doc.getPages().getCOSObject().setItem(COSName.MEDIA_BOX,
                    new PDRectangle(300, 200));
            doc.getPages().getCOSObject().setInt(COSName.ROTATE, 90);
            doc.save(bos);
        }

        byte[] out = run(bos.toByteArray(), spec(page(0, 1, 0), page(0, 0, 90)));
        try (PDDocument doc = PDDocument.load(out)) {
            assertEquals(300, doc.getPage(0).getMediaBox().getWidth(), 0.01);
            assertEquals(90, doc.getPage(0).getRotation());
            assertEquals(180, doc.getPage(1).getRotation());
        }
    }

    @Test
    void rejectsBadRequests() throws Exception {
        byte[] pdf = sizedPdf(100, 200);

        assertThrows(BusinessException.class,
                () -> run(pdf, spec(page(0, 0, 0), page(0, 0, 0))), "duplicate source page");
        assertThrows(BusinessException.class, () -> run(pdf, spec(page(0, 5, 0))),
                "page index out of range");
        assertThrows(BusinessException.class, () -> run(pdf, spec(page(0, 0, 45))),
                "invalid rotation");
        assertThrows(BusinessException.class, () -> run(pdf, spec()), "no pages kept");
        assertThrows(BusinessException.class, () -> run(pdf, spec(page(3, 0, 0))),
                "file index not uploaded");
        assertThrows(BusinessException.class,
                () -> run("not a pdf".getBytes(), spec(page(0, 0, 0))), "unreadable file");
    }

    // ------------------------------------------------------------ helpers

    private byte[] run(byte[] pdf, EditSpec spec) {
        return run(Collections.singletonList(pdf), spec);
    }

    private byte[] run(List<byte[]> pdfs, EditSpec spec) {
        List<InputStream> in = new ArrayList<>();
        for (byte[] b : pdfs) {
            in.add(new ByteArrayInputStream(b));
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        service.apply(spec, in, out);
        return out.toByteArray();
    }

    private static EditSpec spec(PageSpec... pages) {
        EditSpec spec = new EditSpec();
        spec.setPages(new ArrayList<>(Arrays.asList(pages)));
        return spec;
    }

    private static PageSpec page(int doc, int src, int rotate, Markup... markups) {
        PageSpec p = new PageSpec();
        p.setDoc(doc);
        p.setSrc(src);
        p.setRotate(rotate);
        p.setMarkups(new ArrayList<>(Arrays.asList(markups)));
        return p;
    }

    private static Markup highlight(double x, double y, double w, double h) {
        Markup m = new Markup();
        m.setType(MarkupType.HIGHLIGHT);
        m.setX(x);
        m.setY(y);
        m.setWidth(w);
        m.setHeight(h);
        m.setColor("#d32f2f");
        return m;
    }

    private static byte[] blankPdf(int rotation, int pages) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        try (PDDocument doc = new PDDocument()) {
            for (int i = 0; i < pages; i++) {
                PDPage page = new PDPage(new PDRectangle(BASE_W, BASE_H));
                page.setRotation(rotation);
                doc.addPage(page);
            }
            doc.save(bos);
        }
        return bos.toByteArray();
    }

    private static byte[] sizedPdf(float... widths) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        try (PDDocument doc = new PDDocument()) {
            for (float w : widths) {
                doc.addPage(new PDPage(new PDRectangle(w, w)));
            }
            doc.save(bos);
        }
        return bos.toByteArray();
    }

    private static BufferedImage render(byte[] pdf, int page) throws IOException {
        try (PDDocument doc = PDDocument.load(pdf)) {
            return new PDFRenderer(doc).renderImageWithDPI(page, 72);
        }
    }

    /** Where a point on the un-rotated page ends up after rotating the page clockwise. */
    private static double[] rotateForDisplay(double x, double y, double w, double h,
            int degrees) {
        switch (degrees) {
        case 90:
            return new double[] { h - y, x };
        case 180:
            return new double[] { w - x, h - y };
        case 270:
            return new double[] { y, w - x };
        default:
            return new double[] { x, y };
        }
    }

    private static int[] rgb(BufferedImage img, int x, int y) {
        x = Math.max(0, Math.min(img.getWidth() - 1, x));
        y = Math.max(0, Math.min(img.getHeight() - 1, y));
        int p = img.getRGB(x, y);
        return new int[] { (p >> 16) & 0xff, (p >> 8) & 0xff, p & 0xff };
    }

    private static boolean isWhite(BufferedImage img, int x, int y) {
        int[] c = rgb(img, x, y);
        return c[0] > 245 && c[1] > 245 && c[2] > 245;
    }

    private static boolean isReddish(BufferedImage img, int x, int y) {
        int[] c = rgb(img, x, y);
        return c[0] - c[1] > 40 && c[0] - c[2] > 40;
    }

    private static boolean isColor(BufferedImage img, int x, int y, int r, int g, int b) {
        // strokes are anti-aliased, so sample a small neighbourhood for the best match
        for (int dx = -2; dx <= 2; dx++) {
            for (int dy = -2; dy <= 2; dy++) {
                int[] c = rgb(img, x + dx, y + dy);
                if (Math.abs(c[0] - r) < 40 && Math.abs(c[1] - g) < 40
                        && Math.abs(c[2] - b) < 40) {
                    return true;
                }
            }
        }
        return false;
    }

    private static int darkPixels(BufferedImage img, int x0, int y0, int x1, int y1) {
        int count = 0;
        for (int y = Math.max(0, y0); y < Math.min(img.getHeight(), y1); y++) {
            for (int x = Math.max(0, x0); x < Math.min(img.getWidth(), x1); x++) {
                int[] c = rgb(img, x, y);
                if (c[0] + c[1] + c[2] < 384) {
                    count++;
                }
            }
        }
        return count;
    }

    /** Counts any pixel that is not (nearly) white; suits small anti-aliased text. */
    private static int inkedPixels(BufferedImage img, int x0, int y0, int x1, int y1) {
        int count = 0;
        for (int y = Math.max(0, y0); y < Math.min(img.getHeight(), y1); y++) {
            for (int x = Math.max(0, x0); x < Math.min(img.getWidth(), x1); x++) {
                int[] c = rgb(img, x, y);
                if (c[0] + c[1] + c[2] < 735) {
                    count++;
                }
            }
        }
        return count;
    }

    /** Bounding box {x0, y0, x1, y1} of every pixel that is not (nearly) white. */
    private static int[] inkBounds(BufferedImage img) {
        int x0 = Integer.MAX_VALUE;
        int y0 = Integer.MAX_VALUE;
        int x1 = -1;
        int y1 = -1;
        for (int y = 0; y < img.getHeight(); y++) {
            for (int x = 0; x < img.getWidth(); x++) {
                int[] c = rgb(img, x, y);
                if (c[0] + c[1] + c[2] < 735) {
                    x0 = Math.min(x0, x);
                    y0 = Math.min(y0, y);
                    x1 = Math.max(x1, x);
                    y1 = Math.max(y1, y);
                }
            }
        }
        return new int[] { x0, y0, x1, y1 };
    }

    private static void dump(BufferedImage img, String name) throws IOException {
        String dir = System.getProperty("pdfmarkup.dumpDir");
        if (dir != null) {
            ImageIO.write(img, "png", new File(dir, name + ".png"));
        }
    }
}
