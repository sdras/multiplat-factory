package dev.multiplat.fixtures.notes;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONException;

/**
 * Notes as a JSON array under the {@code notes.v1} key, newest first:
 * {@code [{ "id": uuid, "title": string, "body": string, "updatedAt": epochMillis }]}.
 */
public final class NoteStore {
    /** Where the JSON lives: SharedPreferences in the app, a map in tests. */
    public interface Storage {
        String read(String key);

        void write(String key, String value);
    }

    public static final String STORAGE_KEY = "notes.v1";
    public static final int TITLE_LIMIT = 80;

    private final Storage storage;
    private final List<Note> notes = new ArrayList<>();

    public NoteStore(Storage storage) {
        this.storage = storage;
        load();
    }

    public List<Note> notes() {
        return Collections.unmodifiableList(new ArrayList<>(notes));
    }

    public boolean isEmpty() {
        return notes.isEmpty();
    }

    public Note add(String title, String body, long now) {
        Note note = new Note(UUID.randomUUID().toString(), normalizedTitle(title, body), body, now);
        notes.add(0, note);
        save();
        return note;
    }

    public void update(String id, String title, String body, long now) {
        int index = indexOf(id);
        if (index < 0) return;
        notes.remove(index);
        notes.add(0, new Note(id, normalizedTitle(title, body), body, now));
        save();
    }

    public void delete(String id) {
        int index = indexOf(id);
        if (index < 0) return;
        notes.remove(index);
        save();
    }

    public Note find(String id) {
        int index = indexOf(id);
        return index < 0 ? null : notes.get(index);
    }

    /** Case-insensitive match on title or body; an empty query returns everything. */
    public List<Note> filtered(String query) {
        String q = query == null ? "" : query.trim().toLowerCase(Locale.ROOT);
        if (q.isEmpty()) return notes();
        List<Note> out = new ArrayList<>();
        for (Note n : notes) {
            if (n.title.toLowerCase(Locale.ROOT).contains(q) || n.body.toLowerCase(Locale.ROOT).contains(q)) out.add(n);
        }
        return out;
    }

    /** An empty title falls back to the first non-empty body line, then "Untitled"; capped at 80 characters. */
    public static String normalizedTitle(String title, String body) {
        String candidate = title == null ? "" : title.trim();
        if (candidate.isEmpty() && body != null) {
            for (String line : body.split("\\R")) {
                String trimmed = line.trim();
                if (!trimmed.isEmpty()) {
                    candidate = trimmed;
                    break;
                }
            }
        }
        if (candidate.isEmpty()) return "Untitled";
        return candidate.length() > TITLE_LIMIT ? candidate.substring(0, TITLE_LIMIT) : candidate;
    }

    /** One-line preview: whitespace collapsed, cut at {@code limit} characters with an ellipsis. */
    public static String excerpt(String body, int limit) {
        String collapsed = body == null ? "" : body.trim().replaceAll("\\s+", " ");
        if (collapsed.length() <= limit) return collapsed;
        return collapsed.substring(0, limit).trim() + "…";
    }

    private int indexOf(String id) {
        for (int i = 0; i < notes.size(); i++) {
            if (notes.get(i).id.equals(id)) return i;
        }
        return -1;
    }

    private void load() {
        String raw = storage.read(STORAGE_KEY);
        if (raw == null || raw.isEmpty()) return;
        try {
            JSONArray array = new JSONArray(raw);
            for (int i = 0; i < array.length(); i++) notes.add(Note.fromJson(array.getJSONObject(i)));
            notes.sort((a, b) -> Long.compare(b.updatedAt, a.updatedAt));
        } catch (JSONException e) {
            notes.clear();
        }
    }

    private void save() {
        JSONArray array = new JSONArray();
        try {
            for (Note n : notes) array.put(n.toJson());
        } catch (JSONException e) {
            return;
        }
        storage.write(STORAGE_KEY, array.toString());
    }
}
