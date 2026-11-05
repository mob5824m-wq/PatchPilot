import java.io.File

plugins {
    id("com.android.application")
}

/**
 * The version is injected by the release workflow (`-PpatchPilotVersion=1.2.3`)
 * and defaults to 0.0.0 for an ordinary local build, so the APK always reports
 * the same version as the server it pairs with.
 */
val patchPilotVersion: String =
    (findProperty("patchPilotVersion") as String?)?.takeIf { it.isNotBlank() } ?: "0.0.0"

/** 1.2.3 -> 10203, which is what Android wants for versionCode. */
fun versionCodeFor(name: String): Int {
    val parts = name.trim().removePrefix("v").split(".").map { it.toIntOrNull() ?: 0 }
    val major = parts.getOrElse(0) { 0 }
    val minor = parts.getOrElse(1) { 0 }
    val patch = parts.getOrElse(2) { 0 }
    return major * 10_000 + minor * 100 + patch
}

/**
 * The web UI is built by Vite into `dist/web` and shipped inside the APK. Copying
 * it here (rather than committing it) keeps one source of truth for the UI and
 * guarantees the APK always carries the build the release workflow just made.
 */
val webBundle = file("../../dist/web")
val copyWebAssets by tasks.registering(Sync::class) {
    from(webBundle)
    into(layout.projectDirectory.dir("src/main/assets/web"))
    doFirst {
        if (!File(webBundle, "index.html").exists()) {
            throw GradleException(
                "dist/web is missing. Run `npm ci && npm run build` in the repository root before building the APK " +
                    "— the APK carries the web UI."
            )
        }
    }
}

tasks.named("preBuild") { dependsOn(copyWebAssets) }

android {
    namespace = "app.patchpilot"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.patchpilot"
        minSdk = 24
        targetSdk = 34
        versionCode = versionCodeFor(patchPilotVersion)
        versionName = patchPilotVersion.removePrefix("v")
    }

    // A real release keystore is optional: without it the release APK is signed
    // with the debug key, which still installs. Add the four secrets described
    // in android/README.md and the same tag starts producing properly signed
    // APKs, without the workflow changing.
    signingConfigs {
        val keystore = System.getenv("PATCHPILOT_KEYSTORE")
        if (keystore != null && File(keystore).exists()) {
            create("release") {
                storeFile = File(keystore)
                storePassword = System.getenv("PATCHPILOT_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("PATCHPILOT_KEY_ALIAS")
                keyPassword = System.getenv("PATCHPILOT_KEY_PASSWORD")
            }
        }
    }

    val releaseSigning = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            isShrinkResources = false
            signingConfig = releaseSigning
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = false
    }
}
