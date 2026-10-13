package com.example.pdfmarkup.web;

import java.io.StringReader;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import com.example.pdfmarkup.model.EditSpec;
import com.example.pdfmarkup.model.EditSpec.Markup;
import com.example.pdfmarkup.model.EditSpec.MarkupType;
import com.example.pdfmarkup.model.EditSpec.PageSpec;
import com.example.pdfmarkup.service.BusinessException;

import javax.json.Json;
import javax.json.JsonArray;
import javax.json.JsonException;
import javax.json.JsonNumber;
import javax.json.JsonObject;
import javax.json.JsonReader;
import javax.json.JsonString;
import javax.json.JsonValue;

/** Turns the JSON sent by the browser into an {@link EditSpec}, rejecting anything malformed. */
public final class SpecParser {

    private static final int MAX_POINTS_PER_STROKE = 100_000;

    private SpecParser() {
    }

    public static EditSpec parse(String json) {
        if (json == null || json.trim().isEmpty()) {
            throw new BusinessException("The edit request is missing.");
        }
        try (JsonReader reader = Json.createReader(new StringReader(json))) {
            JsonObject root = reader.readObject();
            EditSpec spec = new EditSpec();
            spec.setStamp(root.getBoolean("stamp", false));

            List<PageSpec> pages = new ArrayList<>();
            JsonArray pageArray = root.getJsonArray("pages");
            if (pageArray != null) {
                for (JsonValue value : pageArray) {
                    pages.add(parsePage((JsonObject) value));
                }
            }
            spec.setPages(pages);
            return spec;
        } catch (JsonException | ClassCastException | IllegalStateException
                | IllegalArgumentException e) {
            throw new BusinessException("The edit request was not valid.", e);
        }
    }

    private static PageSpec parsePage(JsonObject o) {
        PageSpec page = new PageSpec();
        page.setDoc(o.getInt("doc", 0));
        page.setSrc(o.getInt("src", 0));
        page.setRotate(o.getInt("rotate", 0));
        page.setBlank(o.getBoolean("blank", false));
        page.setBlankWidth(number(o, "blankWidth", 612));
        page.setBlankHeight(number(o, "blankHeight", 792));

        List<Markup> markups = new ArrayList<>();
        JsonArray array = o.getJsonArray("markups");
        if (array != null) {
            for (JsonValue value : array) {
                markups.add(parseMarkup((JsonObject) value));
            }
        }
        page.setMarkups(markups);
        return page;
    }

    private static Markup parseMarkup(JsonObject o) {
        Markup m = new Markup();
        String type = o.getString("type", "");
        try {
            m.setType(MarkupType.valueOf(type.toUpperCase(Locale.ROOT)));
        } catch (IllegalArgumentException e) {
            throw new BusinessException("Unknown markup type: " + type, e);
        }
        m.setX(number(o, "x", 0));
        m.setY(number(o, "y", 0));
        m.setWidth(number(o, "width", 0));
        m.setHeight(number(o, "height", 0));
        m.setFontSize(number(o, "fontSize", 12));
        m.setLineWidth(number(o, "lineWidth", 2));
        m.setAngle(number(o, "angle", 0));
        m.setColor(o.getString("color", "#d32f2f"));
        if (o.containsKey("text") && !o.isNull("text")) {
            JsonValue text = o.get("text");
            if (text instanceof JsonString) {
                m.setText(((JsonString) text).getString());
            }
        }

        JsonArray points = o.getJsonArray("points");
        if (points != null) {
            if (points.size() > MAX_POINTS_PER_STROKE) {
                throw new BusinessException("A freehand stroke has too many points.");
            }
            List<double[]> list = new ArrayList<>(points.size());
            for (JsonValue value : points) {
                JsonArray pair = (JsonArray) value;
                list.add(new double[] { pair.getJsonNumber(0).doubleValue(),
                        pair.getJsonNumber(1).doubleValue() });
            }
            m.setPoints(list);
        }
        return m;
    }

    private static double number(JsonObject o, String key, double fallback) {
        if (!o.containsKey(key) || o.isNull(key)) {
            return fallback;
        }
        JsonNumber n = o.getJsonNumber(key);
        double value = n.doubleValue();
        if (Double.isNaN(value) || Double.isInfinite(value)) {
            throw new BusinessException("The edit request contains an invalid number.");
        }
        return value;
    }
}
