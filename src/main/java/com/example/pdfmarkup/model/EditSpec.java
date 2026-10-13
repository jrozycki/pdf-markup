package com.example.pdfmarkup.model;

import java.util.ArrayList;
import java.util.List;

/**
 * Describes the edit the browser wants applied: the output page order (pages not listed are
 * deleted), a rotation per page, and the markup drawn on each page.
 *
 * <p>
 * Markup coordinates are in points, measured on the page as it looks <em>before</em> the
 * user's rotation is applied (the page's own /Rotate is already included), with the origin at
 * the top-left. That is the same space PDF.js reports for {@code getViewport({scale: 1})}.
 * </p>
 */
public class EditSpec {

    private List<PageSpec> pages = new ArrayList<>();
    private boolean stamp;
    private String stampText;

    public List<PageSpec> getPages() {
        return pages;
    }

    public void setPages(List<PageSpec> pages) {
        this.pages = pages;
    }

    /** Whether to print a small "marked up" footer on every page. */
    public boolean isStamp() {
        return stamp;
    }

    public void setStamp(boolean stamp) {
        this.stamp = stamp;
    }

    public String getStampText() {
        return stampText;
    }

    public void setStampText(String stampText) {
        this.stampText = stampText;
    }

    public static class PageSpec {

        /** Index of the uploaded file this page comes from (0 is the base document). */
        private int doc;
        /** Zero-based page index in that file. Ignored for blank pages. */
        private int src;
        /** Extra clockwise rotation: 0, 90, 180 or 270. */
        private int rotate;
        private boolean blank;
        private double blankWidth = 612;
        private double blankHeight = 792;
        private List<Markup> markups = new ArrayList<>();

        public int getDoc() {
            return doc;
        }

        public void setDoc(int doc) {
            this.doc = doc;
        }

        public int getSrc() {
            return src;
        }

        public void setSrc(int src) {
            this.src = src;
        }

        public int getRotate() {
            return rotate;
        }

        public void setRotate(int rotate) {
            this.rotate = rotate;
        }

        public boolean isBlank() {
            return blank;
        }

        public void setBlank(boolean blank) {
            this.blank = blank;
        }

        public double getBlankWidth() {
            return blankWidth;
        }

        public void setBlankWidth(double blankWidth) {
            this.blankWidth = blankWidth;
        }

        public double getBlankHeight() {
            return blankHeight;
        }

        public void setBlankHeight(double blankHeight) {
            this.blankHeight = blankHeight;
        }

        public List<Markup> getMarkups() {
            return markups;
        }

        public void setMarkups(List<Markup> markups) {
            this.markups = markups;
        }
    }

    public enum MarkupType {
        HIGHLIGHT, RECT, INK, TEXT, NOTE
    }

    public static class Markup {

        private MarkupType type;
        /** Position (TEXT and NOTE) or top-left corner (HIGHLIGHT and RECT). */
        private double x;
        private double y;
        private double width;
        private double height;
        /** Freehand path as {x, y} pairs (INK). */
        private List<double[]> points = new ArrayList<>();
        /** Text content (TEXT) or comment (NOTE). */
        private String text;
        private double fontSize = 12;
        private double lineWidth = 2;
        /** Colour as #rrggbb. */
        private String color = "#d32f2f";
        /**
         * Clockwise rotation of a TEXT markup about its (x, y) anchor, in degrees, on the page
         * as the user saw it before rotating. Text added while a page is rotated gets the
         * opposite angle so it reads upright in that view.
         */
        private double angle;

        public MarkupType getType() {
            return type;
        }

        public void setType(MarkupType type) {
            this.type = type;
        }

        public double getX() {
            return x;
        }

        public void setX(double x) {
            this.x = x;
        }

        public double getY() {
            return y;
        }

        public void setY(double y) {
            this.y = y;
        }

        public double getWidth() {
            return width;
        }

        public void setWidth(double width) {
            this.width = width;
        }

        public double getHeight() {
            return height;
        }

        public void setHeight(double height) {
            this.height = height;
        }

        public List<double[]> getPoints() {
            return points;
        }

        public void setPoints(List<double[]> points) {
            this.points = points;
        }

        public String getText() {
            return text;
        }

        public void setText(String text) {
            this.text = text;
        }

        public double getFontSize() {
            return fontSize;
        }

        public void setFontSize(double fontSize) {
            this.fontSize = fontSize;
        }

        public double getLineWidth() {
            return lineWidth;
        }

        public void setLineWidth(double lineWidth) {
            this.lineWidth = lineWidth;
        }

        public String getColor() {
            return color;
        }

        public void setColor(String color) {
            this.color = color;
        }

        public double getAngle() {
            return angle;
        }

        public void setAngle(double angle) {
            this.angle = angle;
        }
    }
}
