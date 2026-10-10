package dev.multiplat.fixtures.notes;

import org.json.JSONException;
import org.json.JSONObject;

/** One note; {@code updatedAt} is epoch milliseconds. */
public final class Note {
    public final String id;
    public final String title;
    public final String body;
    public final long updatedAt;

    public Note(String id, String title, String body, long updatedAt) {
        this.id = id;
        this.title = title;
        this.body = body;
        this.updatedAt = updatedAt;
    }

    JSONObject toJson() throws JSONException {
        return new JSONObject().put("id", id).put("title", title).put("body", body).put("updatedAt", updatedAt);
    }

    static Note fromJson(JSONObject json) throws JSONException {
        return new Note(json.getString("id"), json.getString("title"), json.getString("body"), json.getLong("updatedAt"));
    }

    @Override
    public boolean equals(Object other) {
        if (!(other instanceof Note)) return false;
        Note o = (Note) other;
        return id.equals(o.id) && title.equals(o.title) && body.equals(o.body) && updatedAt == o.updatedAt;
    }

    @Override
    public int hashCode() {
        return id.hashCode();
    }

    @Override
    public String toString() {
        return "Note(" + id + ", " + title + ")";
    }
}
