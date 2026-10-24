"""Add annotation intervals and optimistic task revisions."""
from alembic import op
import sqlalchemy as sa

revision = "0002_annotations"
down_revision = "0001_foundation"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("tasks", sa.Column("revision", sa.Integer(), server_default="0", nullable=False))
    op.create_check_constraint(op.f("ck_tasks_positive_revision"), "tasks", "revision >= 0")
    op.create_table(
        "segments",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("task_id", sa.Uuid(), sa.ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False),
        sa.Column("start_ms", sa.Integer(), nullable=False),
        sa.Column("end_ms", sa.Integer(), nullable=False),
        sa.CheckConstraint("start_ms >= 0 AND end_ms > start_ms", name=op.f("ck_segments_valid_interval")),
    )
    op.create_index("ix_segments_task_id", "segments", ["task_id"])
    op.execute("CREATE EXTENSION IF NOT EXISTS btree_gist")
    op.execute("ALTER TABLE segments ADD CONSTRAINT ex_segments_no_overlap "
               "EXCLUDE USING gist (task_id WITH =, int4range(start_ms, end_ms, '[)') WITH &&)")
    op.create_index("ix_tasks_submitted_at", "tasks", ["submitted_at"])


def downgrade():
    op.drop_index("ix_tasks_submitted_at", table_name="tasks")
    op.drop_table("segments")
    op.drop_constraint(op.f("ck_tasks_positive_revision"), "tasks", type_="check")
    op.drop_column("tasks", "revision")
    # btree_gist may be shared by other tables; do not drop the extension.
