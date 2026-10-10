package dev.multiplat.fixtures.notes;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import androidx.appcompat.app.AppCompatActivity;

/** New or existing note: title, body, save; delete only for an existing note. An empty note is never saved. */
public final class NoteEditorActivity extends AppCompatActivity {
    private static final String EXTRA_NOTE_ID = "note_id";

    static Intent intent(Context context, String noteId) {
        Intent intent = new Intent(context, NoteEditorActivity.class);
        if (noteId != null) intent.putExtra(EXTRA_NOTE_ID, noteId);
        return intent;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_note_editor);
        NoteStore store = new NoteStore(new PrefsStorage(this));
        String noteId = getIntent().getStringExtra(EXTRA_NOTE_ID);
        Note existing = noteId == null ? null : store.find(noteId);
        setTitle(existing == null ? R.string.new_note : R.string.edit_note);

        EditText title = findViewById(R.id.note_title);
        EditText body = findViewById(R.id.note_body);
        Button delete = findViewById(R.id.delete_note);
        if (existing != null) {
            title.setText(existing.title);
            body.setText(existing.body);
        }
        delete.setVisibility(existing == null ? View.GONE : View.VISIBLE);
        delete.setOnClickListener(v -> {
            store.delete(noteId);
            finish();
        });
        findViewById(R.id.save_note).setOnClickListener(v -> {
            String t = title.getText().toString();
            String b = body.getText().toString();
            if (!(t.trim().isEmpty() && b.trim().isEmpty())) {
                if (existing == null) store.add(t, b, System.currentTimeMillis());
                else store.update(noteId, t, b, System.currentTimeMillis());
            }
            finish();
        });
    }
}
