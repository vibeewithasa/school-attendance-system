import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.ksp)
}

android {
    namespace = "mx.edu.eta15.prefectura"
    compileSdk = 36

    defaultConfig {
        // Identificador PROVISIONAL de la etapa 1; puede cambiar antes de cualquier distribucion.
        applicationId = "mx.edu.eta15.prefectura"
        minSdk = 26 // Android 8.0: cubre equipos modestos y trae java.time sin desugaring (no se asume el parque de la escuela).
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
            // El modo demostracion (datos 100% ficticios) existe SOLO en debug: en release este flag es false
            // y ademas la clase de datos ficticios ni siquiera se compila (src/release).
            buildConfigField("boolean", "DEMO_MODE", "true")
            // Comprobacion opcional de /health del backend de desarrollo (solo emulador; 10.0.2.2 = localhost del anfitrion).
            buildConfigField("String", "DEV_HEALTH_URL", "\"http://10.0.2.2:3000/health\"")
            // Servidor de PRUEBAS de la vinculacion experimental (ADR 0005, propuesta). Solo debug y solo el anfitrion del emulador.
            buildConfigField("String", "MOBILE_BASE_URL", "\"http://10.0.2.2:3000\"")
            // Vigencia offline de DEMOSTRACION en minutos (SANDBOX ONLY). Se puede acortar para ensayar el vencimiento:
            // gradlew ... -Peta15.offlineValidityMinutes=2
            buildConfigField("int", "OFFLINE_VALIDITY_MINUTES", (project.findProperty("eta15.offlineValidityMinutes") ?: "30").toString())
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            buildConfigField("boolean", "DEMO_MODE", "false")
            buildConfigField("String", "DEV_HEALTH_URL", "\"\"")
            buildConfigField("String", "MOBILE_BASE_URL", "\"\"")
            buildConfigField("int", "OFFLINE_VALIDITY_MINUTES", "0")
            // Sin signingConfig: la firma release se disenara antes de cualquier distribucion.
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    lint {
        abortOnError = true
        checkReleaseBuilds = true
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }

    sourceSets {
        // Los esquemas exportados de Room se usan en las pruebas de migracion.
        getByName("androidTest").assets.srcDir("$projectDir/schemas")
    }
}

kotlin {
    jvmToolchain(21)
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.navigation.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.core)
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)
    implementation(libs.sqlcipher.android)
    implementation(libs.androidx.sqlite)
    implementation(libs.kotlinx.coroutines.android)
    // Ya es transitiva (1.7.3 via AndroidX); se fija 1.9.0 para que room-testing (androidTest) funcione con resolucion consistente.
    implementation(libs.kotlinx.serialization.core)

    debugImplementation(libs.androidx.compose.ui.tooling)
    debugImplementation(libs.androidx.compose.ui.test.manifest)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)

    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.espresso.core)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    androidTestImplementation(libs.androidx.room.testing)
    androidTestImplementation(libs.kotlinx.coroutines.test)
}
