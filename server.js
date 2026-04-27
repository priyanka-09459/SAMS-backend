const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const path = require("path");
const multer = require("multer");
const upload = multer({ dest: "uploads/" });

const app = express();
aapp.use(cors({
  origin: "*",
  methods: ["GET","POST","PUT","DELETE"],
  allowedHeaders: ["Content-Type"]
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, "../frontend")));

// REPLACE the hardcoded db connection with this:
const db = mysql.createConnection({
  host:     process.env.DB_HOST,
  user:     process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port:     process.env.DB_PORT || 3306
});

db.connect((err) => {
    if (err) { console.log("DB Error:", err); }
    else { console.log("MySQL Connected"); }
});

// ============================================================
// ADMIN ROUTES
// ============================================================

app.post("/admin-login", (req, res) => {
    const { username, password } = req.body;
    db.query("SELECT * FROM admin WHERE username=? AND password=?", [username, password], (err, result) => {
        if (err) return res.json({ success: false });
        const success = result.length > 0;
        // ADDITION 5: Log login attempt
        db.query("INSERT INTO login_logs (user_id, role, status) VALUES (?,?,?)",
            [username, "admin", success ? "success" : "failed"]);
        res.json({ success });
    });
});

app.post("/change-admin-password", (req, res) => {
    const { oldPass, newPass } = req.body;
    db.query("SELECT * FROM admin WHERE password=?", [oldPass], (err, result) => {
        if (err || result.length === 0) return res.json({ success: false, message: "Old password incorrect" });
        db.query("UPDATE admin SET password=? WHERE password=?", [newPass, oldPass], (err) => {
            if (err) return res.json({ success: false });
            res.json({ success: true });
        });
    });
});

// ============================================================
// TEACHER ROUTES
// ============================================================

app.post("/teacher-login", (req, res) => {
    const { email, password } = req.body;
    db.query("SELECT * FROM teachers WHERE email=? AND password=?", [email, password], (err, result) => {
        if (err) return res.json({ success: false });
        const success = result.length > 0;
        // ADDITION 5: Log login attempt
        db.query("INSERT INTO login_logs (user_id, role, status) VALUES (?,?,?)",
            [email, "teacher", success ? "success" : "failed"]);
        if (!success) return res.json({ success: false });
        res.json({ success: true, name: result[0].name, email: result[0].email });
    });
});

// Bulk add teachers from uploaded CSV/JSON array
app.post("/bulk-add-teachers", (req, res) => {
    const { teachers } = req.body;
    if (!teachers || teachers.length === 0) return res.json({ success: false });

    let values = teachers.map(t => {
        const password = t.email.substring(0, 5);
        return [t.email.trim(), t.name.trim(), password];
    });

    const sql = "INSERT IGNORE INTO teachers (email, name, password) VALUES ?";
    db.query(sql, [values], (err) => {
        if (err) { console.log(err); return res.json({ success: false }); }
        res.json({ success: true, count: values.length });
    });
});

app.post("/get-teacher", (req, res) => {
    const { email } = req.body;
    db.query("SELECT * FROM teachers WHERE email=?", [email], (err, result) => {
        if (err || result.length === 0) return res.json({ teacher: null });
        res.json({ teacher: result[0] });
    });
});

app.post("/change-teacher-password", (req, res) => {
    const { email, oldPass, newPass } = req.body;
    db.query("SELECT * FROM teachers WHERE email=? AND password=?", [email, oldPass], (err, result) => {
        if (err || result.length === 0) return res.json({ success: false, message: "Old password incorrect" });
        db.query("UPDATE teachers SET password=? WHERE email=?", [newPass, email], (err) => {
            if (err) return res.json({ success: false });
            res.json({ success: true });
        });
    });
});

// Assign subjects to teacher (each subject as separate row)
app.post("/assign-subject", (req, res) => {
    const { teacherEmail, teacherName, school, branch, year, semester, section, subjects } = req.body;
    if (!teacherEmail || !subjects || subjects.length === 0) return res.json({ success: false });

    db.query("DELETE FROM teacher_subjects WHERE teacher_email=? AND branch=? AND semester=? AND section=?",
        [teacherEmail, branch, semester, section], (err) => {
            if (err) return res.json({ success: false });

            let values = subjects.map(s => [teacherEmail, teacherName, school, branch, year, semester, section, s.code, s.name]);
            db.query("INSERT INTO teacher_subjects (teacher_email, teacher_name, school, branch, year, semester, section, subject_code, subject_name) VALUES ?",
                [values], (err) => {
                    if (err) { console.log(err); return res.json({ success: false }); }
                    res.json({ success: true });
                });
        });
});

// View teacher subjects by branch + semester
app.post("/view-teacher-subjects", (req, res) => {
    const { branch, semester } = req.body;
    db.query("SELECT * FROM teacher_subjects WHERE branch=? AND semester=? ORDER BY teacher_email",
        [branch, semester], (err, result) => {
            if (err) return res.json({ records: [] });
            res.json({ records: result });
        });
});

// Get subjects assigned to a specific teacher
app.post("/get-teacher-subjects", (req, res) => {
    const { email } = req.body;
    db.query("SELECT * FROM teacher_subjects WHERE teacher_email=?", [email], (err, result) => {
        if (err) return res.json({ subjects: [] });
        res.json({ subjects: result });
    });
});

// Get teacher subjects filtered by branch + semester (for mark attendance dropdown)
app.post("/get-teacher-subjects-filtered", (req, res) => {
    const { email, branch, semester } = req.body;
    if(!email || !branch || !semester) return res.json({ subjects: [] });
    // Return distinct subject_code+subject_name for this teacher's branch+semester (across all sections)
    db.query(
        `SELECT DISTINCT subject_code, subject_name, branch, semester, section
         FROM teacher_subjects
         WHERE teacher_email=? AND branch=? AND semester=?
         ORDER BY subject_name`,
        [email, branch, semester], (err, result) => {
            if (err) { console.log("get-teacher-subjects-filtered error:", err); return res.json({ subjects: [] }); }
            console.log(`Subjects for ${email} | ${branch} | ${semester}:`, result.length);
            res.json({ subjects: result });
        });
});

// ── SHORTAGE: SEMESTER (students below 75% for the whole semester) ──
app.post("/shortage-semester-report", (req, res) => {
    const { branch, semester, section, subject_code } = req.body;
    if (!branch || !semester || !section || !subject_code)
        return res.json({ records: [] });
    const sql = `
        SELECT
            s.regno,
            s.name,
            SUM(CASE WHEN a.status='Present' THEN 1 ELSE 0 END) AS present_count,
            COUNT(a.id) AS total_classes,
            ROUND(
                SUM(CASE WHEN a.status='Present' THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(a.id),0),
                2
            ) AS percentage
        FROM students s
        INNER JOIN attendance a
            ON a.regno = s.regno
           AND a.branch = s.branch
           AND a.semester = s.semester
           AND a.section = s.section
        WHERE s.branch=? AND s.semester=? AND s.section=?
          AND a.subject_code=?
        GROUP BY s.regno, s.name
        HAVING percentage < 75
        ORDER BY percentage ASC`;
    db.query(sql, [branch, semester, section, subject_code], (err, result) => {
        if (err) { console.log("shortage-semester-report error:", err); return res.json({ records: [] }); }
        res.json({ records: result });
    });
});

// ── SHORTAGE: MONTH (students below 75% in a specific month) ──
app.post("/shortage-month-report", (req, res) => {
    const { branch, semester, section, subject_code, month_sort } = req.body;
    if (!branch || !semester || !section || !subject_code || !month_sort)
        return res.json({ records: [] });
    const sql = `
        SELECT
            s.regno,
            s.name,
            SUM(CASE WHEN a.status='Present' THEN 1 ELSE 0 END) AS present_count,
            COUNT(a.id) AS total_classes,
            ROUND(
                SUM(CASE WHEN a.status='Present' THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(a.id),0),
                2
            ) AS percentage
        FROM students s
        INNER JOIN attendance a
            ON a.regno = s.regno
           AND a.branch = s.branch
           AND a.semester = s.semester
           AND a.section = s.section
        WHERE s.branch=? AND s.semester=? AND s.section=?
          AND a.subject_code=?
          AND DATE_FORMAT(a.date, '%Y-%m') = ?
        GROUP BY s.regno, s.name
        HAVING percentage < 75
        ORDER BY percentage ASC`;
    db.query(sql, [branch, semester, section, subject_code, month_sort], (err, result) => {
        if (err) { console.log("shortage-month-report error:", err); return res.json({ records: [] }); }
        res.json({ records: result });
    });
});


app.post("/remove-teacher-subject", (req, res) => {
    const { id } = req.body;
    db.query("DELETE FROM teacher_subjects WHERE id=?", [id], (err) => {
        if (err) return res.json({ success: false });
        res.json({ success: true });
    });
});

// ============================================================
// STUDENT ROUTES
// ============================================================

app.post("/student-login", (req, res) => {
    const { regno, password } = req.body;
    db.query("SELECT * FROM students WHERE regno=? AND password=?", [regno, password], (err, result) => {
        if (err) return res.json({ success: false });
        const success = result.length > 0;
        // ADDITION 5: Log login attempt
        db.query("INSERT INTO login_logs (user_id, role, status) VALUES (?,?,?)",
            [regno, "student", success ? "success" : "failed"]);
        if (!success) return res.json({ success: false });
        res.json({ success: true, name: result[0].name, regno: result[0].regno });
    });
});

app.post("/verify-payment", (req, res) => {
    const { email, tid } = req.body;
    db.query("SELECT * FROM payments WHERE email=? AND tid=? AND is_used=0", [email, tid], (err, result) => {
        if (err) return res.json({ success: false });
        res.json({ success: result.length > 0 });
    });
});

// Admin uploads Excel/CSV of email+TID pairs — bulk insert into payments table
app.post("/upload-tids", async (req, res) => {
    const { rows } = req.body;
    if (!rows || rows.length === 0) return res.json({ success: false, inserted: 0, skipped: 0 });

    const query = (sql, params) => new Promise((resolve, reject) => {
        db.query(sql, params, (err, result) => err ? reject(err) : resolve(result));
    });

    try {
        let inserted = 0;
        let skipped  = 0;

        for (const row of rows) {
            const email = (row.email || "").trim().toLowerCase();
            const tid   = (row.tid   || "").trim();
            if (!email || !tid) { skipped++; continue; }

            // Check if this exact email+tid pair already exists
            const existing = await query(
                "SELECT id FROM payments WHERE email=? AND tid=?",
                [email, tid]
            );
            if (existing.length > 0) { skipped++; continue; }

            await query(
                "INSERT INTO payments (email, tid, is_used) VALUES (?, ?, 0)",
                [email, tid]
            );
            inserted++;
        }

        res.json({ success: true, inserted, skipped });
    } catch (err) {
        console.log("upload-tids error:", err);
        res.json({ success: false, inserted: 0, skipped: 0 });
    }
});

app.post("/student-register", (req, res) => {
    const { regno, name, email, school, program, branch, year, semester, section, password } = req.body;
    db.query("SELECT * FROM students WHERE regno=? OR email=?", [regno, email], (err, result) => {
        if (err) return res.json({ success: false });
        if (result.length > 0) return res.json({ success: false, message: "Student already registered" });

        db.query("INSERT INTO students (regno, name, email, school, program, branch, year, semester, section, password) VALUES (?,?,?,?,?,?,?,?,?,?)",
            [regno, name, email, school, program, branch, year, semester, section, password], (err) => {
                if (err) { console.log(err); return res.json({ success: false }); }

                // ADDITION 4: Mark TID as used so it cannot be reused
                db.query("UPDATE payments SET is_used=1, used_at=NOW() WHERE email=?", [email]);

                // ADDITION 3: Send welcome notification to new student
                db.query("INSERT INTO notifications (regno, message, sent_by) VALUES (?,?,?)",
                    [regno, `Welcome ${name}! Your registration is complete. Your username is your Registration Number: ${regno}.`, "system"]);

                res.json({ success: true });
            });
    });
});

app.post("/add-student", (req, res) => {
    const { regno, name, email, school, program, branch, year, semester, section, password } = req.body;
    db.query("INSERT INTO students (regno, name, email, school, program, branch, year, semester, section, password) VALUES (?,?,?,?,?,?,?,?,?,?)",
        [regno, name, email, school, program, branch, year, semester, section, password], (err) => {
            if (err) { console.log(err); return res.json({ success: false }); }
            res.json({ success: true });
        });
});

app.post("/delete-student", (req, res) => {
    const { regno } = req.body;
    db.query("DELETE FROM students WHERE regno=?", [regno], (err, result) => {
        if (err) return res.json({ success: false });
        res.json({ success: result.affectedRows > 0 });
    });
});

app.post("/get-student", (req, res) => {
    const { regno } = req.body;
    db.query("SELECT * FROM students WHERE regno=?", [regno], (err, result) => {
        if (err || result.length === 0) return res.json({ student: null });
        res.json({ student: result[0] });
    });
});

app.post("/modify-student", (req, res) => {
    const { regno, name, school, branch, year, semester, section } = req.body;
    db.query("UPDATE students SET name=?, school=?, branch=?, year=?, semester=?, section=? WHERE regno=?",
        [name, school, branch, year, semester, section, regno], (err) => {
            if (err) return res.json({ success: false });
            res.json({ success: true });
        });
});

app.post("/change-student-password", (req, res) => {
    const { regno, oldPass, newPass } = req.body;
    db.query("SELECT * FROM students WHERE regno=? AND password=?", [regno, oldPass], (err, result) => {
        if (err || result.length === 0) return res.json({ success: false, message: "Old password incorrect" });
        db.query("UPDATE students SET password=? WHERE regno=?", [newPass, regno], (err) => {
            if (err) return res.json({ success: false });
            res.json({ success: true });
        });
    });
});

// Student semester-wise overall summary per subject
app.post("/student-semester-report", async (req, res) => {
    const regno = (req.body.regno || "").trim();
    if (!regno) return res.json({ records: [] });

    const query = (sql, params) => new Promise((resolve, reject) => {
        db.query(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
    });

    try {
        // 1. Get student's branch + semester
        const students = await query("SELECT branch, semester FROM students WHERE regno=?", [regno]);
        if (!students.length) return res.json({ records: [] });
        const { branch, semester } = students[0];

        // 2. Get all subjects for this branch+semester
        const courseRows = await query(
            "SELECT DISTINCT subject_code, subject_name FROM courses WHERE branch=? AND semester=?",
            [branch, semester]
        );

        // 3. Get this student's attendance totals per subject
        const attRows = await query(
            `SELECT subject_code,
                    COUNT(*) AS total_classes,
                    SUM(CASE WHEN status='Present' THEN 1 ELSE 0 END) AS present_count
             FROM attendance
             WHERE regno=?
             GROUP BY subject_code`,
            [regno]
        );

        // 4. Build attendance map
        const attMap = {};
        attRows.forEach(a => { attMap[a.subject_code] = a; });

        // 5. Merge — every course appears
        const records = courseRows.map(c => {
            const a       = attMap[c.subject_code] || { total_classes: 0, present_count: 0 };
            const total   = Number(a.total_classes)  || 0;
            const present = Number(a.present_count) || 0;
            const pct     = total === 0 ? 0 : Math.round(present / Math.min(total, 30) * 10000) / 100;
            return {
                subject:       c.subject_name,
                subject_code:  c.subject_code,
                semester,
                total_classes: total,
                present_count: present,
                percentage:    pct,
                eligible:      total === 0 ? "No Classes Yet"
                               : pct >= 75  ? "Eligible"
                               :              "Not Eligible"
            };
        });
        records.sort((a, b) => a.subject.localeCompare(b.subject));
        res.json({ records });

    } catch (err) {
        console.log("student-semester-report error:", err);
        res.json({ records: [] });
    }
});
app.post("/student-monthly-report", async (req, res) => {
    const regno = (req.body.regno || "").trim();
    if (!regno) return res.json({ records: [], months: [] });

    const query = (sql, params) => new Promise((resolve, reject) => {
        db.query(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
    });

    try {
        // 1. Get student's branch + semester
        const students = await query("SELECT branch, semester FROM students WHERE regno=?", [regno]);
        if (!students.length) return res.json({ records: [], months: [] });
        const { branch, semester } = students[0];

        // 2. Get distinct months this student has attendance (months dropdown)
        const monthRows = await query(
            `SELECT DISTINCT
                DATE_FORMAT(date, '%M %Y') AS month,
                DATE_FORMAT(date, '%Y-%m') AS month_sort
             FROM attendance
             WHERE regno=?
             ORDER BY month_sort`,
            [regno]
        );
        if (!monthRows.length) return res.json({ records: [], months: [] });

        // 3. Get all subjects assigned to this branch+semester
        const courseRows = await query(
            "SELECT DISTINCT subject_code, subject_name FROM courses WHERE branch=? AND semester=?",
            [branch, semester]
        );

        // 4. Get this student's attendance per subject per month
        const attRows = await query(
            `SELECT subject_code,
                    DATE_FORMAT(date, '%Y-%m') AS month_sort,
                    COUNT(*) AS total_classes,
                    SUM(CASE WHEN status='Present' THEN 1 ELSE 0 END) AS present_count
             FROM attendance
             WHERE regno=?
             GROUP BY subject_code, DATE_FORMAT(date, '%Y-%m')`,
            [regno]
        );

        // 5. Build lookup map  "subjectCode|monthSort" -> counts
        const attMap = {};
        attRows.forEach(a => {
            attMap[a.subject_code + "|" + a.month_sort] = {
                total_classes: Number(a.total_classes)  || 0,
                present_count: Number(a.present_count) || 0
            };
        });

        // 6. Build records: every month × every course
        const records = [];
        monthRows.forEach(m => {
            courseRows.forEach(c => {
                const att     = attMap[c.subject_code + "|" + m.month_sort] || { total_classes: 0, present_count: 0 };
                const total   = att.total_classes;
                const present = att.present_count;
                const pct     = total === 0 ? 0 : Math.round(present / Math.min(total, 30) * 10000) / 100;
                records.push({
                    subject:       c.subject_name,
                    subject_code:  c.subject_code,
                    semester,
                    month:         m.month,
                    month_sort:    m.month_sort,
                    total_classes: total,
                    present_count: present,
                    percentage:    pct,
                    eligible:      total === 0 ? "No Classes Yet"
                                   : pct >= 75  ? "Eligible"
                                   :              "Not Eligible"
                });
            });
        });

        res.json({ records, months: monthRows });

    } catch (err) {
        console.log("student-monthly-report error:", err);
        res.json({ records: [], months: [] });
    }
});

// ============================================================
// ATTENDANCE ROUTES
// ============================================================

// Get students filtered by branch/semester/section
app.get("/get-students", (req, res) => {
    const { branch, semester, section, school } = req.query;
    let sql = "SELECT regno, name FROM students WHERE 1=1";
    let params = [];
    if (school)   { sql += " AND school=?";   params.push(school); }
    if (branch)   { sql += " AND branch=?";   params.push(branch); }
    if (semester) { sql += " AND semester=?"; params.push(semester); }
    if (section)  { sql += " AND section=?";  params.push(section); }
    db.query(sql, params, (err, result) => {
        if (err) return res.json({ students: [] });
        res.json({ students: result });
    });
});

// Save attendance (class + optional individual correction)
app.post("/save-attendance", (req, res) => {
    const { attendance, date, subject, subject_code, semester, branch, section } = req.body;
    if (!attendance || attendance.length === 0) return res.json({ success: false });

    const attendanceDate = date || new Date().toISOString().split("T")[0];
    let values = attendance.map(a => [a.regno, a.status, attendanceDate, subject, subject_code, semester, branch, section]);

    db.query("INSERT INTO attendance (regno, status, date, subject, subject_code, semester, branch, section) VALUES ?",
        [values], (err) => {
            if (err) { console.log(err); return res.json({ success: false }); }
            res.json({ success: true });
        });
});

// Save individual student attendance (correction)
app.post("/save-individual-attendance", (req, res) => {
    const { regno, status, date, subject, subject_code, semester, branch, section } = req.body;
    db.query("INSERT INTO attendance (regno, status, date, subject, subject_code, semester, branch, section) VALUES (?,?,?,?,?,?,?,?)",
        [regno, status, date, subject, subject_code, semester, branch, section], (err) => {
            if (err) { console.log(err); return res.json({ success: false }); }
            res.json({ success: true });
        });
});

// Get available months for a class (only months where attendance was taken)
app.post("/get-attendance-months", (req, res) => {
    const { branch, semester, section, subject_code } = req.body;
    let sql = `
        SELECT DISTINCT DATE_FORMAT(date, '%M %Y') AS month,
               DATE_FORMAT(date, '%Y-%m') AS month_sort
        FROM attendance
        WHERE branch=? AND semester=? AND section=?
    `;
    const params = [branch, semester, section];
    if(subject_code){ sql += ` AND subject_code=?`; params.push(subject_code); }
    sql += ` ORDER BY month_sort`;
    db.query(sql, params, (err, result) => {
        if(err) return res.json([]);
        res.json(result);
    });
});

// Full semester report for whole class (filtered by subject if provided)
app.post("/class-semester-report", (req, res) => {
    const { branch, semester, section, subject_code } = req.body;
    let sql = `
        SELECT a.regno, s.name, a.subject, a.subject_code,
               COUNT(*) AS total_classes,
               SUM(CASE WHEN a.status='Present' THEN 1 ELSE 0 END) AS present_count,
               ROUND((SUM(CASE WHEN a.status='Present' THEN 1 ELSE 0 END) / LEAST(COUNT(*),30)) * 100, 2) AS percentage
        FROM attendance a
        JOIN students s ON a.regno = s.regno
        WHERE a.branch=? AND a.semester=? AND a.section=?
    `;
    const params = [branch, semester, section];
    if(subject_code){ sql += ` AND a.subject_code=?`; params.push(subject_code); }
    sql += ` GROUP BY a.regno, s.name, a.subject, a.subject_code ORDER BY a.regno, a.subject`;
    db.query(sql, params, (err, result) => {
        if(err) return res.json({ records: [] });
        const records = result.map(r => ({ ...r, eligible: r.percentage >= 75 ? "Eligible" : "Not Eligible" }));
        res.json({ records });
    });
});

// Month wise report for whole class (filtered by subject if provided)
app.post("/class-month-report", (req, res) => {
    const { branch, semester, section, month_sort, subject_code } = req.body;
    let sql = `
        SELECT a.regno, s.name, a.subject, a.subject_code,
               COUNT(*) AS total_classes,
               SUM(CASE WHEN a.status='Present' THEN 1 ELSE 0 END) AS present_count,
               ROUND((SUM(CASE WHEN a.status='Present' THEN 1 ELSE 0 END) / LEAST(COUNT(*),30)) * 100, 2) AS percentage
        FROM attendance a
        JOIN students s ON a.regno = s.regno
        WHERE a.branch=? AND a.semester=? AND a.section=?
          AND DATE_FORMAT(a.date, '%Y-%m')=?
    `;
    const params = [branch, semester, section, month_sort];
    if(subject_code){ sql += ` AND a.subject_code=?`; params.push(subject_code); }
    sql += ` GROUP BY a.regno, s.name, a.subject, a.subject_code ORDER BY a.regno, a.subject`;
    db.query(sql, params, (err, result) => {
        if(err) return res.json({ records: [] });
        const records = result.map(r => ({ ...r, eligible: r.percentage >= 75 ? "Eligible" : "Not Eligible" }));
        res.json({ records });
    });
});

// Student wise report (filtered by subject if provided)
app.post("/student-wise-report", (req, res) => {
    const { branch, semester, section, regno, subject_code } = req.body;
    let sql = `
        SELECT a.regno, s.name, a.subject, a.subject_code,
               COUNT(*) AS total_classes,
               SUM(CASE WHEN a.status='Present' THEN 1 ELSE 0 END) AS present_count,
               ROUND((SUM(CASE WHEN a.status='Present' THEN 1 ELSE 0 END) / LEAST(COUNT(*),30)) * 100, 2) AS percentage
        FROM attendance a
        JOIN students s ON a.regno = s.regno
        WHERE a.branch=? AND a.semester=? AND a.section=? AND a.regno=?
    `;
    const params = [branch, semester, section, regno];
    if(subject_code){ sql += ` AND a.subject_code=?`; params.push(subject_code); }
    sql += ` GROUP BY a.regno, s.name, a.subject, a.subject_code ORDER BY a.subject`;
    db.query(sql, params, (err, result) => {
        if(err) return res.json({ records: [] });
        const records = result.map(r => ({ ...r, eligible: r.percentage >= 75 ? "Eligible" : "Not Eligible" }));
        res.json({ records });
    });
});

// ============================================================
// COURSE ROUTES
// ============================================================

app.post("/set-course-subject", (req, res) => {
    const { school, branch, year, semester, section, subjects } = req.body;
    if (!branch || !semester || !subjects || subjects.length === 0) return res.json({ success: false });

    let values = subjects.map(s => [school, branch, year, semester, section, s.code, s.name]);
    db.query("INSERT IGNORE INTO courses (school, branch, year, semester, section, subject_code, subject_name) VALUES ?",
        [values], (err) => {
            if (err) { console.log(err); return res.json({ success: false }); }
            res.json({ success: true });
        });
});

app.post("/get-subjects", (req, res) => {
    const { branch, semester } = req.body;
    db.query("SELECT subject_code AS code, subject_name AS name FROM courses WHERE branch=? AND semester=?",
        [branch, semester], (err, result) => {
            if (err) return res.json([]);
            res.json(result);
        });
});

app.post("/delete-subject", (req, res) => {
    const { code, branch, semester } = req.body;
    db.query("DELETE FROM courses WHERE subject_code=? AND branch=? AND semester=?",
        [code, branch, semester], (err, result) => {
            if (err) return res.json({ success: false });
            res.json({ success: result.affectedRows > 0 });
        });
});

// ============================================================
// NOTIFICATION ROUTES (ADDITION 3)
// ============================================================

// Send notification to one student or all students
app.post("/send-notification", (req, res) => {
    const { regno, message, sent_by } = req.body;
    if (!message) return res.json({ success: false });
    // If regno is empty send to all (stored with NULL regno)
    const target = regno && regno.trim() !== "" ? regno.trim() : null;
    db.query("INSERT INTO notifications (regno, message, sent_by) VALUES (?,?,?)",
        [target, message, sent_by || "admin"], (err) => {
            if (err) { console.log(err); return res.json({ success: false }); }
            res.json({ success: true });
        });
});

// Get notifications for a student (their personal + broadcast)
app.post("/get-notifications", (req, res) => {
    const { regno } = req.body;
    db.query("SELECT * FROM notifications WHERE regno=? OR regno IS NULL ORDER BY created_at DESC",
        [regno], (err, result) => {
            if (err) return res.json({ notifications: [] });
            res.json({ notifications: result });
        });
});

// Mark notification as read
app.post("/mark-notification-read", (req, res) => {
    const { id } = req.body;
    db.query("UPDATE notifications SET is_read=1 WHERE id=?", [id], (err) => {
        if (err) return res.json({ success: false });
        res.json({ success: true });
    });
});

// Get unread notification count for a student
app.post("/unread-count", (req, res) => {
    const { regno } = req.body;
    db.query("SELECT COUNT(*) AS count FROM notifications WHERE (regno=? OR regno IS NULL) AND is_read=0",
        [regno], (err, result) => {
            if (err) return res.json({ count: 0 });
            res.json({ count: result[0].count });
        });
});

// ============================================================
// LOGIN LOGS ROUTES (ADDITION 5)
// ============================================================

// Admin views all login logs
app.get("/login-logs", (req, res) => {
    db.query("SELECT * FROM login_logs ORDER BY login_time DESC LIMIT 100", (err, result) => {
        if (err) return res.json({ logs: [] });
        res.json({ logs: result });
    });
});

// ============================================================
// PAGE ROUTES
// ============================================================

app.get("/",           (req, res) => res.sendFile(path.join(__dirname, "../frontend/index.html")));
app.get("/student",    (req, res) => res.sendFile(path.join(__dirname, "../frontend/student_options.html")));
app.get("/teacher",    (req, res) => res.sendFile(path.join(__dirname, "../frontend/teacher_login.html")));
app.get("/admin",      (req, res) => res.sendFile(path.join(__dirname, "../frontend/admin_login.html")));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));